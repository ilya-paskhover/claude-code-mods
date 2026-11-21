import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SettingsSource } from 'claude-code'

import type { Block, InstructionFile, NamedSize, Scan, SettingsFile, Tab } from '../types'
import {
  cell,
  describeKey,
  findImports,
  fmt,
  isOnDemand,
  joinPath,
  mcpServers,
  modelsIn,
  resolveImport,
  shortPath,
  splitBlocks,
  tokens,
} from './scan'

const PANE = 'config-map'
const TITLE = 'Config map'
const ALL = '__all'
const UNTAGGED = '__untagged'
const MAX_IMPORT_DEPTH = 5

const scanAtom = atom({ plugin: 'config-map', key: 'scan' } as const, null, { shape: 'scan-1' })
const tabAtom = atom({ plugin: 'config-map', key: 'tab' } as const, 'instructions')
const modelAtom = atom({ plugin: 'config-map', key: 'model' } as const, ALL)

const tryRead = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

const listMd = async ($: EngineInterface, dir: string, depth = 3): Promise<string[]> => {
  if (depth < 0) return []
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = joinPath(dir, entry.name)
    if (entry.kind === 'dir') out.push(...(await listMd($, path, depth - 1)))
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(path)
  }
  return out
}

const frontmatterDescription = (text: string) =>
  /^---\r?\n[\s\S]*?^description:\s*(.*)$/m.exec(text)?.[1] ?? ''

async function scan($: EngineInterface): Promise<Scan> {
  const errors: string[] = []
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  const cfg = joinPath((await $.env.get('CLAUDE_CONFIG_DIR')) ?? joinPath(home, '.claude'), '')
  const root = joinPath(await $.session.root(), '')
  const model = await $.session.model()

  const files: InstructionFile[] = []
  const blocks: Block[] = []
  const seen = new Set<string>()
  const key = (p: string) => (isWindows ? p.toLowerCase() : p)

  const addFile = async (
    path: string,
    scope: InstructionFile['scope'],
    depth = 0,
    importedBy?: string,
  ): Promise<void> => {
    if (seen.has(key(path))) return
    const text = await tryRead($, path)
    if (text === undefined) {
      if (scope === 'Import') errors.push(`Import not found: ${shortPath(path, home)} (from ${shortPath(importedBy ?? '', home)})`)
      return
    }
    seen.add(key(path))
    files.push({ path, scope, tokens: tokens(text), onDemand: scope === 'Rule' && isOnDemand(text), importedBy })
    blocks.push(...splitBlocks(text, path))
    if (depth >= MAX_IMPORT_DEPTH) return
    for (const imp of findImports(text)) {
      await addFile(resolveImport(imp, path, home), 'Import', depth + 1, path)
    }
  }

  // Managed (organization) instructions, then the user's, then the project's.
  const managed = isWindows
    ? ['C:/Program Files/ClaudeCode/CLAUDE.md']
    : ['/etc/claude-code/CLAUDE.md', '/Library/Application Support/ClaudeCode/CLAUDE.md']
  for (const path of managed) await addFile(path, 'Managed')
  await addFile(joinPath(cfg, 'CLAUDE.md'), 'User')
  for (const path of await listMd($, joinPath(cfg, 'rules'))) await addFile(path, 'Rule')

  try {
    const found = await $.fs.ancestors({ names: ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] })
    for (const f of found) {
      await addFile(joinPath(f.dir, f.name), f.name === 'CLAUDE.local.md' ? 'Local' : 'Project')
    }
  } catch (err) {
    errors.push(`Could not walk project folders: ${String(err)}`)
  }
  for (const path of await listMd($, joinPath(root, '.claude/rules'))) await addFile(path, 'Rule')

  // Settings: read through the engine, so every platform's managed path is
  // covered. Only key names and counts are kept, never values.
  const sources: [SettingsSource, string][] = [
    ['user', joinPath(cfg, 'settings.json')],
    ['project', joinPath(root, '.claude/settings.json')],
    ['local', joinPath(root, '.claude/settings.local.json')],
    ['flag', '--settings / SDK'],
    ['policy', 'managed settings'],
  ]
  const settings: SettingsFile[] = []
  for (const [source, path] of sources) {
    try {
      const obj = (await $.settings.read({ source })) as Record<string, unknown>
      settings.push({ source, path, keys: Object.entries(obj).map(([k, v]) => describeKey(k, v)) })
    } catch (err) {
      errors.push(`Could not read ${source} settings: ${String(err)}`)
    }
  }

  // Skills and commands: what the model's listing carries is name + description.
  const skills: NamedSize[] = []
  try {
    for (const c of await $.command.list()) {
      skills.push({ name: c.name, source: c.plugin ?? c.source, tokens: tokens(`${c.name} ${c.description}`) })
    }
  } catch (err) {
    errors.push(`Could not list commands: ${String(err)}`)
  }
  skills.sort((a, b) => b.tokens - a.tokens)

  const agents: NamedSize[] = []
  for (const [dir, source] of [
    [joinPath(cfg, 'agents'), 'user'],
    [joinPath(root, '.claude/agents'), 'project'],
  ] as const) {
    for (const path of await listMd($, dir, 1)) {
      const text = (await tryRead($, path)) ?? ''
      const name = path.split('/').pop()?.replace(/\.md$/i, '') ?? path
      agents.push({ name, source, tokens: tokens(`${name} ${frontmatterDescription(text)}`) })
    }
  }

  let mcp: Scan['mcp'] = []
  try {
    mcp = mcpServers(await $.tool.list())
  } catch (err) {
    errors.push(`Could not list tools: ${String(err)}`)
  }

  return { at: await $.clock.now(), home, model, files, blocks, settings, skills, agents, mcp, errors }
}

// Which models the current session runs: "claude-opus-5-5" -> ["Opus 5.5"].
const currentModels = (s: Scan) => modelsIn(s.model)

const isForOtherModel = (b: Block, now: string[]) =>
  b.models.length > 0 && now.length > 0 && !b.models.some(m => now.includes(m))

const instructionsMarkdown = (s: Scan, filter: string): string => {
  const now = currentModels(s)
  const total = s.files.filter(f => !f.onDemand).reduce((n, f) => n + f.tokens, 0)
  const other = s.blocks.filter(b => isForOtherModel(b, now)).reduce((n, b) => n + b.tokens, 0)
  const lines: string[] = []
  lines.push(
    `**~${fmt(total)} tokens** load every session from ${s.files.length} file${s.files.length === 1 ? '' : 's'}.` +
      (now.length > 0 ? ` Model now: **${now.join(', ')}**.` : ` Model now: ${s.model}.`) +
      (other > 0 ? ` ⚠ **~${fmt(other)} tokens** are tagged for another model.` : ''),
  )
  lines.push('', '#### Files', '', '| Scope | File | ~Tokens | Loads |', '|---|---|--:|---|')
  for (const f of s.files) {
    const via = f.importedBy ? ` (from ${shortPath(f.importedBy, s.home)})` : ''
    lines.push(`| ${f.scope} | \`${cell(shortPath(f.path, s.home))}\`${cell(via)} | ${fmt(f.tokens)} | ${f.onDemand ? 'on demand' : 'always'} |`)
  }

  const tags = new Map<string, { blocks: number; tokens: number }>()
  for (const b of s.blocks) {
    for (const m of b.models.length > 0 ? b.models : ['Any model']) {
      const row = tags.get(m) ?? { blocks: 0, tokens: 0 }
      row.blocks++
      row.tokens += b.tokens
      tags.set(m, row)
    }
  }
  lines.push('', '#### By model', '', '| Model | Blocks | ~Tokens |', '|---|--:|--:|')
  for (const [m, row] of tags) lines.push(`| ${m} | ${row.blocks} | ${fmt(row.tokens)} |`)

  const cats = new Map<string, number>()
  for (const b of s.blocks) cats.set(b.category, (cats.get(b.category) ?? 0) + b.tokens)
  lines.push('', '#### By category', '', '| Category | ~Tokens |', '|---|--:|')
  for (const [c, n] of [...cats].sort((a, b) => b[1] - a[1])) lines.push(`| ${cell(c)} | ${fmt(n)} |`)

  const shown = s.blocks.filter(b =>
    filter === ALL ? true : filter === UNTAGGED ? b.models.length === 0 : b.models.includes(filter),
  )
  lines.push('', '#### Blocks', '', '| Block | Where | Category | Model | ~Tokens |', '|---|---|---|---|--:|')
  for (const b of shown) {
    const indent = b.level > 1 ? `${'·'.repeat(b.level - 1)} ` : ''
    const warn = isForOtherModel(b, now) ? ' ⚠' : ''
    const where = `${shortPath(b.file, s.home).split('/').pop()}:${b.line}`
    lines.push(
      `| ${indent}${cell(b.heading)} | ${cell(where)} | ${cell(b.category)} | ${b.models.length > 0 ? cell(b.models.join(', ')) + warn : 'any'} | ${fmt(b.tokens)} |`,
    )
  }
  if (shown.length === 0) lines.push('| (none) | | | | |')
  lines.push(
    '',
    'Tag a block for a model with `<!-- model: opus-5.5 -->` under its heading, or name the model in the heading. ' +
      'Set a category with `<!-- category: Git -->`. To drop a model\'s blocks in one step, move them into their own file and `@import` it from CLAUDE.md.',
  )
  return lines.join('\n')
}

const settingsMarkdown = (s: Scan): string => {
  const lines: string[] = [
    'Settings files configure the harness; they are **not** sent to the model, so they cost no context tokens. Only key names and counts are shown, never values.',
  ]
  for (const f of s.settings) {
    lines.push('', `#### ${f.source} · \`${cell(shortPath(f.path, s.home))}\``, '')
    if (f.keys.length === 0) {
      lines.push('_empty or absent_')
      continue
    }
    lines.push('| Key | Holds | Size (chars) |', '|---|---|--:|')
    for (const k of [...f.keys].sort((a, b) => b.size - a.size)) {
      lines.push(`| ${cell(k.key)} | ${cell(k.summary)} | ${fmt(k.size)} |`)
    }
  }
  return lines.join('\n')
}

const extrasMarkdown = (s: Scan): string => {
  const lines: string[] = []
  const sum = (rows: { tokens: number }[]) => rows.reduce((n, r) => n + r.tokens, 0)
  lines.push(`#### MCP servers · ~${fmt(sum(s.mcp))} tokens`, '', '| Server | Tools | ~Tokens |', '|---|--:|--:|')
  for (const m of s.mcp) lines.push(`| ${cell(m.server)} | ${m.tools} | ${fmt(m.tokens)} |`)
  if (s.mcp.length === 0) lines.push('| (none) | | |')
  lines.push('', 'Tool counts are names and descriptions only; `/context` also counts input schemas.')

  const bySource = new Map<string, { n: number; tokens: number }>()
  for (const k of s.skills) {
    const row = bySource.get(k.source) ?? { n: 0, tokens: 0 }
    row.n++
    row.tokens += k.tokens
    bySource.set(k.source, row)
  }
  lines.push('', `#### Skills and commands · ~${fmt(sum(s.skills))} tokens`, '', '| Source | Count | ~Tokens |', '|---|--:|--:|')
  for (const [src, row] of [...bySource].sort((a, b) => b[1].tokens - a[1].tokens)) {
    lines.push(`| ${cell(src)} | ${row.n} | ${fmt(row.tokens)} |`)
  }
  lines.push('', '| Largest | Source | ~Tokens |', '|---|---|--:|')
  for (const k of s.skills.slice(0, 15)) lines.push(`| ${cell(k.name)} | ${cell(k.source)} | ${fmt(k.tokens)} |`)

  lines.push('', `#### Agents (user and project files) · ~${fmt(sum(s.agents))} tokens`, '')
  if (s.agents.length === 0) lines.push('_none_')
  else {
    lines.push('| Agent | Source | ~Tokens |', '|---|---|--:|')
    for (const a of s.agents) lines.push(`| ${cell(a.name)} | ${a.source} | ${fmt(a.tokens)} |`)
  }
  return lines.join('\n')
}

async function refresh($: EngineInterface): Promise<Scan> {
  const s = await scan($)
  await update($, scanAtom, () => s)
  return s
}

const summary = (s: Scan) => {
  const total = s.files.filter(f => !f.onDemand).reduce((n, f) => n + f.tokens, 0)
  const now = currentModels(s)
  const other = s.blocks.filter(b => isForOtherModel(b, now)).reduce((n, b) => n + b.tokens, 0)
  return (
    `Config map: ${s.files.length} instruction files, ${s.blocks.length} blocks, ~${fmt(total)} tokens.` +
    (other > 0 ? ` ~${fmt(other)} tokens are tagged for a model other than ${now.join(', ')}.` : '')
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'config-map',
      description: 'Map CLAUDE.md blocks, settings, skills and MCP by size, category and model',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'config-map' }, async $ => {
    const s = await refresh($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return { text: opened.isPlaced ? summary(s) : `${summary(s)}\nPane not drawn: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Select, Text } = $.ui.resolve(e)
    const s = await read($, scanAtom)
    const tab = await read($, tabAtom)
    const filter = await read($, modelAtom)
    if (s === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Not scanned yet.</Text>
          <Button key="scan" label="Scan" onPress={() => refresh($)} />
        </Box>
      )
    }
    const models = [...new Set(s.blocks.flatMap(b => b.models))].sort()
    const tabs: [Tab, string][] = [
      ['instructions', 'Instructions'],
      ['settings', 'Settings'],
      ['extras', 'Skills · MCP · Agents'],
    ]
    const body = tab === 'settings' ? settingsMarkdown(s) : tab === 'extras' ? extrasMarkdown(s) : instructionsMarkdown(s, filter)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {tabs.map(([id, label]) => (
            <Button key={`tab-${id}`} label={tab === id ? `[${label}]` : label} onPress={() => update($, tabAtom, () => id)} />
          ))}
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
        {tab === 'instructions' ? (
          <Select
            key="model-filter"
            label="Blocks for"
            value={filter}
            options={[
              { value: ALL, label: 'All blocks' },
              { value: UNTAGGED, label: 'Any model (untagged)' },
              ...models.map(m => ({ value: m, label: m })),
            ]}
            onSelect={value => update($, modelAtom, () => value)}
          />
        ) : null}
        <Markdown text={body} />
        {s.errors.length > 0 ? <Text dimColor>{s.errors.join('\n')}</Text> : null}
      </Box>
    )
  })
}
