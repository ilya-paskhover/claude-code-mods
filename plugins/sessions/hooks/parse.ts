import type { SessionRow } from '../types'

// A busy session whose file has not changed for this long may have died
// without cleaning up; it is drawn dimmed with a question mark.
export const STALE_MS = 30 * 60_000

export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

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
    hostSessionId: str(o.hostSessionId),
  }
}

// status_bucket, SESSION_STATUS_BUCKET_WORKING and so on, in look's words.
const BUCKETS: Record<string, string> = {
  working: 'busy',
  blocked: 'blocked',
  review_ready: 'idle',
  completed: 'idle',
  failed: 'failed',
}

// needs_action sits in external_metadata.post_turn_summary; the top-level
// post_turn_summary has been seen without it.
const needsAction = (holder: unknown) => {
  const summary = (holder as { post_turn_summary?: unknown } | null | undefined)?.post_turn_summary
  return str((summary as { needs_action?: unknown } | null | undefined)?.needs_action)
}

const cloudRow = (item: unknown): SessionRow | undefined => {
  if (typeof item !== 'object' || item === null) return undefined
  const o = item as Record<string, unknown>
  const id = str(o.id)
  if (id === undefined) return undefined
  const bucket = str(o.status_bucket)?.replace(/^SESSION_STATUS_BUCKET_/, '').toLowerCase() ?? 'unknown'
  return {
    id,
    cwd: '',
    name: str(o.title) ?? id,
    status: BUCKETS[bucket] ?? bucket,
    updatedAt: num(Date.parse(str(o.updated_at) ?? '')) ?? 0,
    url: `https://claude.ai/code/${encodeURIComponent(id)}`,
    needs: needsAction(o.external_metadata) ?? needsAction(o),
  }
}

// The claude-code-remote server's list_sessions result, not part of the mod
// API: read defensively. Its JSON can come wrapped in an untrusted-data
// envelope, so only the span from the first { to the last } is parsed.
export const parseCloudSessions = (text: string): SessionRow[] | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return undefined
  }
  const o = raw as { ccr?: { data?: unknown }; data?: unknown } | null
  const list = o?.ccr?.data ?? o?.data
  if (!Array.isArray(list)) return undefined
  return list.map(cloudRow).filter((row): row is SessionRow => row !== undefined)
}

// CLAUDE_CODE_REMOTE_SESSION_ID reads cse_<id> where list_sessions says
// session_<id>.
export const cloudSessionId = (remoteId: string) => `session_${remoteId.replace(/^[a-z]+_/, '')}`

// The desktop app opens a session it started from this link: the one its own
// session tools hand out to open a session from outside the app. Not public API.
export const switchLink = (row: SessionRow) =>
  row.hostSessionId === undefined ? undefined : `claude://claude.ai/epitaxy/${encodeURIComponent(row.hostSessionId)}`

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

export type Look = { dot: string; label: string; color?: string; isDim: boolean }

export const look = (row: SessionRow, now: number): Look => {
  if (row.status === 'busy') {
    const isStale = now - row.updatedAt > STALE_MS
    return { dot: '●', label: isStale ? 'working?' : 'working', color: 'warning', isDim: isStale }
  }
  if (row.status === 'idle') return { dot: '○', label: 'idle', color: 'success', isDim: false }
  if (row.status === 'blocked') return { dot: '◐', label: 'needs input', color: 'warning', isDim: false }
  if (row.status === 'failed') return { dot: '✗', label: 'failed', color: 'error', isDim: false }
  return { dot: '·', label: row.status, isDim: true }
}
