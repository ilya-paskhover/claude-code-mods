import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SettingsSource } from 'claude-code'

import type { Block, InstructionFile, Scan, SettingsFile, Tab } from '../types'
import {
  cell,
  describeKey,
  findImports,
  isOnDemand,
  joinPath,
  modelsIn,
  resolveImport,
  shortPath,
  splitBlocks,
} from './scan'

const PANE = 'config-map'
const TITLE = 'Config map'
const ALL = '__all'
const UNTAGGED = '__untagged'
const MAX_IMPORT_DEPTH = 5

// scan-2: blocks carry their text and settings rows their masked value; a
// scan stored by 0.1.x reads as null and is taken again.
const scanAtom = atom({ plugin: 'config-map', key: 'scan' } as const, null, { shape: 'scan-2' })
const tabAtom = atom({ plugin: 'config-map', key: 'tab' } as const, 'instructions')
const modelAtom = atom({ plugin: 'config-map', key: 'model' } as const, ALL)
const openAtom = atom({ plugin: 'config-map', key: 'open' } as const, [] as string[])

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
    files.push({ path, scope, onDemand: scope === 'Rule' && isOnDemand(text), importedBy })
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
  // covered. Env values and secret-looking keys are masked before they are kept.
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
      const keys = Object.entries(obj).map(([k, v]) => describeKey(k, v))
      settings.push({ source, path, keys: keys.sort((a, b) => a.key.localeCompare(b.key)) })
    } catch (err) {
      errors.push(`Could not read ${source} settings: ${String(err)}`)
    }
  }

  return { at: await $.clock.now(), home, model, files, blocks, settings, errors }
}

// Which models the current session runs: "claude-opus-5-5" -> ["Opus 5.5"].
const currentModels = (s: Scan) => modelsIn(s.model)

const isForOtherModel = (b: Block, now: string[]) =>
  b.models.length > 0 && now.length > 0 && !b.models.some(m => now.includes(m))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const filesMarkdown = (s: Scan): string => {
  const now = currentModels(s)
  const other = s.blocks.filter(b => isForOtherModel(b, now)).length
  const always = s.files.filter(f => !f.onDemand).length
  const lines = [
    `${plural(always, 'file')} load every session` +
      (always < s.files.length ? `, ${s.files.length - always} on demand` : '') +
      `. Model now: **${now.length > 0 ? now.join(', ') : s.model}**.` +
      (other > 0 ? ` ⚠ ${plural(other, 'block')} tagged for another model.` : ''),
    '',
    '| Scope | File | Loads |',
    '|---|---|---|',
  ]
  for (const f of s.files) {
    const via = f.importedBy ? ` (from ${shortPath(f.importedBy, s.home)})` : ''
    lines.push(`| ${f.scope} | \`${cell(shortPath(f.path, s.home))}\`${cell(via)} | ${f.onDemand ? 'on demand' : 'always'} |`)
  }
  return lines.join('\n')
}

const HINT =
  'Tag a block for a model with `<!-- model: opus-5.5 -->` under its heading, or name the model in the heading. ' +
  "Set a category with `<!-- category: Git -->`. To drop a model's blocks in one step, move them into their own file and `@import` it from CLAUDE.md."

async function refresh($: EngineInterface): Promise<Scan> {
  const s = await scan($)
  await update($, scanAtom, () => s)
  return s
}

const summary = (s: Scan) => {
  const now = currentModels(s)
  const other = s.blocks.filter(b => isForOtherModel(b, now)).length
  return (
    `Config map: ${s.files.length} instruction files, ${s.blocks.length} blocks.` +
    (other > 0 ? ` ${plural(other, 'block')} tagged for a model other than ${now.join(', ')}.` : '')
  )
}

const COMMAND = {
  name: 'config-map',
  description: 'Map your CLAUDE.md blocks and settings, unfold any row to read it',
  immediate: true,
} as const

// A line typed as `/config-map` that reached prompt.submit as plain text: the
// session had not registered the command yet.
const TYPED = /^\s*\/config-map\s*$/

const run = async ($: EngineInterface): Promise<string> => {
  const s = await refresh($)
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  return opened.isPlaced ? summary(s) : `${summary(s)}\nPane not drawn: ${opened.reason}`
}

// `session.start` fires once per session. A session that was already running
// when the plugin was installed, or that loaded it through /reload-plugins,
// never sees it, so the command is also registered on the first prompt this
// copy of the module hears. A reload starts the flag over; registering a name
// again replaces it.
let isRegistered = false
const ensureCommand = async ($: EngineInterface): Promise<void> => {
  if (isRegistered) return
  await $.command.register(COMMAND)
  isRegistered = true
}

export const register: Register = on => {
  isRegistered = false

  on('session.start', async ($, e, next) => {
    await ensureCommand($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await ensureCommand($)
    } catch {
      // Registration is retried on the next prompt; the prompt itself goes on.
    }
    // The line that brought us here was typed before the command existed: answer
    // it now instead of sending `/config-map` to the model as text.
    // Only the person's own typing counts: never a peer's or a notification's text.
    const isOwn = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    if (isOwn && !e.command && !e.isMeta && TYPED.test(e.text)) return { drop: await run($) }
    return next(e)
  })

  on('command.run', { command: 'config-map' }, async $ => ({ text: await run($) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Markdown, Select, Text } = $.ui.resolve(e)
    const s = await read($, scanAtom)
    // A tab stored by 0.1.x ('extras') falls back to Instructions.
    const tab: Tab = (await read($, tabAtom)) === 'settings' ? 'settings' : 'instructions'
    const filter = await read($, modelAtom)
    const open = new Set(await read($, openAtom))
    if (s === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Not scanned yet.</Text>
          <Button key="scan" label="Scan" onPress={() => refresh($)} />
        </Box>
      )
    }

    const toggle = (id: string) =>
      update($, openAtom, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

    // One foldable row: the title and a dim note; unfolded, the content below it.
    const row = (id: string, title: string, note: string, source: string, language: string, startLine?: number) => (
      <Box flexDirection="column">
        <Button key={id} plain onPress={() => toggle(id)}>
          {`${open.has(id) ? '▾' : '▸'} ${title}  `}
          <Text dimColor>{note}</Text>
        </Button>
        {open.has(id) ? <Code source={source} language={language} startLine={startLine} /> : null}
      </Box>
    )

    const tabs: [Tab, string][] = [
      ['instructions', 'Instructions'],
      ['settings', 'Settings'],
    ]
    const header = (
      <Box flexDirection="row" gap={1}>
        {tabs.map(([id, label]) => (
          <Button key={`tab-${id}`} label={tab === id ? `[${label}]` : label} onPress={() => update($, tabAtom, () => id)} />
        ))}
        <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        {open.size > 0 ? <Button key="fold" label="Fold all" onPress={() => update($, openAtom, () => [])} /> : null}
      </Box>
    )
    const errors = s.errors.length > 0 ? <Text dimColor>{s.errors.join('\n')}</Text> : null

    if (tab === 'settings') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor>
            Settings configure Claude Code; the model does not read them. Unfold a key to see its value. Env values and
            secret-looking keys show as •••.
          </Text>
          {s.settings.map(f => (
            <Box flexDirection="column">
              <Text bold>{`${f.source} · ${shortPath(f.path, s.home)}`}</Text>
              {f.keys.length === 0 ? <Text dimColor>empty or absent</Text> : null}
              {f.keys.map(k => row(`s:${f.source}:${k.key}`, k.key, k.summary, k.json, 'json'))}
            </Box>
          ))}
          {errors}
        </Box>
      )
    }

    const now = currentModels(s)
    const models = [...new Set(s.blocks.flatMap(b => b.models))].sort()
    const shown = s.blocks.filter(b =>
      filter === ALL ? true : filter === UNTAGGED ? b.models.length === 0 : b.models.includes(filter),
    )
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Markdown text={filesMarkdown(s)} />
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
        {s.files.map(f => {
          const mine = shown.filter(b => b.file === f.path)
          if (mine.length === 0) return null
          return (
            <Box flexDirection="column">
              <Text bold>{shortPath(f.path, s.home)}</Text>
              {mine.map(b => {
                const model = b.models.length > 0 ? b.models.join(', ') : 'any model'
                const warn = isForOtherModel(b, now) ? ' ⚠' : ''
                const title = `${'  '.repeat(Math.max(0, b.level - 1))}${b.heading}`
                return row(`b:${b.file}:${b.line}`, title, `${b.category} · ${model}${warn}`, b.text, 'markdown', b.line)
              })}
            </Box>
          )
        })}
        {shown.length === 0 ? <Text dimColor>No blocks for this model.</Text> : null}
        <Markdown text={HINT} />
        {errors}
      </Box>
    )
  })
}
