// Pure parsing for config-map: no `$`, so the tests drive it directly.

import type { Block, KeyRow } from '../types'

// A rough token count. English runs near 4 characters a token; Cyrillic and
// other non-ASCII text runs nearer 2. Good enough to rank blocks, not to bill.
export const tokens = (text: string): number => {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 2)
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const MODEL_MARK = /<!--\s*model\s*:\s*([^>]*?)\s*-->/i
const CATEGORY_MARK = /<!--\s*category\s*:\s*([^>]*?)\s*-->/i
// Name first ("claude-opus-4-1-20250805", "Sonnet 5.5"). Versions are one or
// two digits, so a date stamp after them ("-20250514") is not read as a minor.
const MODEL_NAME = /\b(opus|sonnet|haiku|fable)[\s-]*(\d{1,2}(?!\d)(?:[.-]\d{1,2}(?!\d))?)/gi
// Version first, the older ids: "claude-3-7-sonnet-20250219", "Claude 3.5 Haiku".
const MODEL_NAME_OLD = /\bclaude[\s-](\d)(?:[.-](\d))?[\s-](opus|sonnet|haiku)\b/gi

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

// "opus-5.5, Sonnet 5.5" and "claude-opus-5-5" both become ["Opus 5.5", "Sonnet 5.5"].
export const modelsIn = (text: string): string[] => {
  const found: { at: number; name: string }[] = []
  for (const m of text.matchAll(MODEL_NAME)) {
    found.push({ at: m.index ?? 0, name: `${titleCase(m[1] ?? '')} ${(m[2] ?? '').replace('-', '.')}` })
  }
  for (const m of text.matchAll(MODEL_NAME_OLD)) {
    found.push({ at: m.index ?? 0, name: `${titleCase(m[3] ?? '')} ${m[1]}${m[2] ? `.${m[2]}` : ''}` })
  }
  const names: string[] = []
  for (const f of found.sort((a, b) => a.at - b.at)) if (!names.includes(f.name)) names.push(f.name)
  return names
}

// Ordered: the first rule whose words appear wins. A marker overrides all.
const CATEGORY_RULES: [string, RegExp][] = [
  ['Secrets', /\.env\b|\bsecret|password|\.pem\b|\.ssh\b|credential/i],
  ['Email', /\bemail|\be-mail|\binbox\b|\botp\b/i],
  ['Git', /\bgit\b|\bcommit|\bpush\b|\bbranch|\brebase/i],
  ['Safety', /destructive|\bdelete\b|ask before|confirm/i],
  ['Testing', /\btests?\b|type-?check|\bbuild\b|\bverify/i],
  ['Agents', /subagent|\bagents?\b|autonom/i],
  ['Reporting', /bottom line|heading|bullet|tl;dr|summary|report/i],
  ['Style', /\bstyle\b|\btone\b|format|\breply\b|\banswer\b|symbol/i],
]

export const categoryOf = (heading: string, body: string): string => {
  const mark = CATEGORY_MARK.exec(body)?.[1]
  if (mark) return mark
  for (const [name, rule] of CATEGORY_RULES) if (rule.test(heading)) return name
  for (const [name, rule] of CATEGORY_RULES) if (rule.test(body)) return name
  return 'General'
}

// A CommonMark code fence: it opens on 3+ backticks or tildes and closes only
// on a run of the same character, at least as long, with nothing after it.
// Returns a function that says, line by line, whether that line is code
// (a fence line included).
export const fenceTracker = () => {
  let open: { ch: string; len: number } | null = null
  return (line: string): boolean => {
    const m = FENCE.exec(line)
    const run = m?.[1] ?? ''
    const rest = m?.[2] ?? ''
    if (open !== null) {
      if (m && run[0] === open.ch && run.length >= open.len && rest.trim() === '') open = null
      return true
    }
    // A backtick fence's info string cannot hold a backtick: that is inline code.
    if (m && !(run[0] === '`' && rest.includes('`'))) {
      open = { ch: run[0] ?? '`', len: run.length }
      return true
    }
    return false
  }
}

// The index of a frontmatter block's closing `---`, or -1. A file that merely
// opens with a horizontal rule is not frontmatter: the first line inside must
// read as YAML (`key:`).
export const frontmatterEnd = (lines: readonly string[]): number => {
  if (lines[0]?.trim() !== '---') return -1
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return -1
  const first = lines.slice(1, end).find(l => l.trim() !== '')
  return first !== undefined && /^[A-Za-z_][\w-]*\s*:/.test(first) ? end : -1
}

// Splits markdown into blocks at headings (outside code fences). Text before
// the first heading is its own block. A heading's model tag passes down to
// the headings nested under it, so "## Focus" under "# Opus 5.5 tuning" is
// Opus 5.5 too.
export const splitBlocks = (text: string, file: string): Block[] => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // Frontmatter (a rule's `paths:`, say) is metadata, not a block: blank it,
  // keeping the line numbers.
  const end = frontmatterEnd(lines)
  for (let i = 0; i <= end; i++) lines[i] = ''
  const raw: { heading: string; level: number; lines: string[]; start: number }[] = []
  let current = { heading: '', level: 0, lines: [] as string[], start: 1 }
  const isCode = fenceTracker()
  lines.forEach((line, i) => {
    const h = isCode(line) ? null : HEADING.exec(line)
    if (h) {
      raw.push(current)
      current = { heading: h[2] ?? '', level: (h[1] ?? '#').length, lines: [line], start: i + 1 }
    } else {
      current.lines.push(line)
    }
  })
  raw.push(current)

  const stack: { level: number; models: string[] }[] = []
  const blocks: Block[] = []
  for (const part of raw) {
    const body = part.lines.join('\n')
    if (part.level === 0 && body.trim() === '') continue
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= part.level && part.level > 0) stack.pop()
    const mark = MODEL_MARK.exec(body)?.[1]
    const own = mark !== undefined ? modelsIn(mark) : modelsIn(part.heading)
    const inherited = stack.length > 0 ? (stack[stack.length - 1]?.models ?? []) : []
    const models = own.length > 0 ? own : inherited
    if (part.level > 0) stack.push({ level: part.level, models })
    blocks.push({
      file,
      line: part.start,
      heading: part.heading || '(top of file)',
      level: part.level,
      tokens: tokens(body),
      models,
      category: categoryOf(part.heading, body),
    })
  }
  return blocks
}

// `@path` imports, as the engine reads them: outside code fences and inline
// code, starting a word, not an email address.
export const findImports = (text: string): string[] => {
  const found: string[] = []
  const isCode = fenceTracker()
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (isCode(line)) continue
    const bare = line.replace(/`[^`]*`/g, '')
    for (const m of bare.matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/|[A-Za-z]:[\\/])?[^\s`'"()<>]+)/g)) {
      const path = (m[1] ?? '').replace(/[.,;:!?]+$/, '')
      if (path.includes('@') || !/[./\\]/.test(path)) continue
      if (!found.includes(path)) found.push(path)
    }
  }
  return found
}

export const isAbsolute = (path: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(path)

export const dirOf = (path: string) => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut)
}

// Joins and collapses `.` and `..`, keeping the forward slash the engine
// accepts on every platform.
export const joinPath = (base: string, rel: string): string => {
  const raw = isAbsolute(rel) ? rel : `${base}/${rel}`
  const slashed = raw.replace(/\\/g, '/')
  const lead = /^[A-Za-z]:\//.test(slashed) ? slashed.slice(0, 3) : slashed.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const part of slashed.slice(lead.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return lead + out.join('/')
}

export const resolveImport = (path: string, fromFile: string, home: string) =>
  path.startsWith('~/') ? joinPath(home, path.slice(2)) : joinPath(dirOf(fromFile), path)

// A rules file with `paths:` frontmatter loads only when Claude reads a
// matching file; without it, it loads every session.
export const isOnDemand = (text: string) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  return m !== null && /^paths\s*:/m.test(m[1] ?? '')
}

// What one settings key holds, never its values: `env` and helper commands
// may carry secrets, so the pane shows names and counts only.
export const describeKey = (key: string, value: unknown): KeyRow => {
  const size = JSON.stringify(value ?? null).length
  let summary: string
  if (Array.isArray(value)) summary = `${value.length} item${value.length === 1 ? '' : 's'}`
  else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (key === 'permissions') {
      summary = ['allow', 'ask', 'deny']
        .map(k => (Array.isArray(obj[k]) ? `${(obj[k] as unknown[]).length} ${k}` : ''))
        .filter(Boolean)
        .join(', ') || `${Object.keys(obj).length} keys`
    } else if (key === 'hooks') {
      summary = Object.keys(obj).join(', ') || 'none'
    } else if (key === 'env') {
      summary = `${Object.keys(obj).length} variables`
    } else if (key === 'enabledPlugins') {
      const on = Object.values(obj).filter(v => v === true).length
      summary = `${on} on, ${Object.keys(obj).length - on} off`
    } else summary = `${Object.keys(obj).length} keys`
  } else if (key === 'model' || typeof value === 'boolean' || typeof value === 'number') {
    summary = String(value)
  } else summary = typeof value === 'string' ? `text, ${value.length} chars` : String(value)
  return { key, size, summary }
}

// Groups `mcp__server__tool` names by server.
export const mcpServers = (tools: readonly { name: string; description: string; mcp: boolean }[]) => {
  const by = new Map<string, { tools: number; tokens: number }>()
  for (const t of tools) {
    if (!t.mcp) continue
    const server = t.name.split('__')[1] ?? t.name
    const row = by.get(server) ?? { tools: 0, tokens: 0 }
    row.tools++
    row.tokens += tokens(t.name + t.description)
    by.set(server, row)
  }
  return [...by.entries()].map(([server, row]) => ({ server, ...row })).sort((a, b) => b.tokens - a.tokens)
}

export const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export const shortPath = (path: string, home: string) => {
  const p = path.replace(/\\/g, '/')
  const h = home.replace(/\\/g, '/').replace(/\/$/, '')
  return h !== '' && p.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${p.slice(h.length)}` : p
}

export const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
