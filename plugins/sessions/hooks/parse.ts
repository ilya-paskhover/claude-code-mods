import type { SessionRow } from '../types'

// A busy session whose file has not changed for this long may have died
// without cleaning up; it is drawn dimmed with a question mark.
export const STALE_MS = 30 * 60_000

export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// Claude Code's own session file, not part of the mod API: read defensively.
export const parseSession = (text: string): SessionRow | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

  const id = str(o.sessionId)
  const pid = num(o.pid)
  if (id === undefined || pid === undefined) return undefined
  const cwd = str(o.cwd) ?? ''
  return {
    id,
    pid,
    cwd,
    name: str(o.name) ?? (cwd !== '' ? folderName(cwd) : id.slice(0, 8)),
    status: str(o.status) ?? 'unknown',
    updatedAt: num(o.updatedAt) ?? num(o.statusUpdatedAt) ?? num(o.startedAt) ?? 0,
    entrypoint: str(o.entrypoint),
  }
}

// Working sessions first, then the most recently active; one row per session.
export const sortRows = (rows: readonly SessionRow[]): SessionRow[] => {
  const newest = new Map<string, SessionRow>()
  for (const row of rows) {
    const seen = newest.get(row.id)
    if (seen === undefined || row.updatedAt > seen.updatedAt) newest.set(row.id, row)
  }
  return [...newest.values()].sort((a, b) => {
    const busy = Number(b.status === 'busy') - Number(a.status === 'busy')
    return busy !== 0 ? busy : b.updatedAt - a.updatedAt
  })
}

export const ago = (ms: number) => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// One line standing for a note: its first line of text, past any pasted
// wrapper, code fence or Markdown marker, cut to fit a pane row.
const LINE_CHARS = 80

export const firstLine = (text: string) => {
  const line =
    text
      .replace(/<\/?pasted_content\b[^>]*>/g, '')
      .split('\n')
      .map(one => one.replace(/^\s*(```\S*|#+|[-*>]|\d+\.)\s*/, '').trim())
      .find(one => one !== '') ?? ''
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line
}

export type Look ={ dot: string; label: string; color?: string; isDim: boolean }

export const look = (row: SessionRow, now: number): Look => {
  if (row.status === 'busy') {
    const isStale = now - row.updatedAt > STALE_MS
    return { dot: '●', label: isStale ? 'working?' : 'working', color: 'warning', isDim: isStale }
  }
  if (row.status === 'idle') return { dot: '○', label: 'idle', color: 'success', isDim: false }
  return { dot: '·', label: row.status, isDim: true }
}
