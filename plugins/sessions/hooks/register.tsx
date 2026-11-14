import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SessionRow } from '../types'
import {
  ago,
  cloudSessionId,
  foldRows,
  HISTORY_MS,
  look,
  mergeHistory,
  type Missing,
  nestRows,
  parseCloudSessions,
  parseDesktopSession,
  parseProcessTable,
  parseSession,
  projectFolder,
  readHistory,
  sessionAncestor,
  sortRows,
  switchLink,
  transcriptModel,
} from './parse'

// Claude Code writes one <pid>.json per running session into its config
// folder's sessions/ directory. That file is the engine's own, not mod API.
// A cloud container holds only its own session, so there the list comes from
// the claude-code-remote MCP server every cloud session has.
const PANE = 'sessions'
const PANE_TITLE = 'Sessions'
const REFRESH_MS = 5_000
// Each cloud refresh is an API call, not a folder read.
const CLOUD_REFRESH_MS = 30_000
const REMOTE_SERVER = 'claude-code-remote'
// Enough to reach back HISTORY_MS for most people; older ones are dropped.
const CLOUD_LIMIT = 50
// $.store key: every session seen in the last HISTORY_MS, kept across sessions.
const HISTORY_KEY = 'history'

const rows = atom({ plugin: 'sessions', key: 'rows' } as const, [])
const sessionId = atom({ plugin: 'sessions', key: 'sessionId' } as const, '')
const now = atom({ plugin: 'sessions', key: 'now' } as const, 0)
const error = atom({ plugin: 'sessions', key: 'error' } as const, '')
// In $.state, not a module variable: a reload fires session.start again and
// must not reopen a pane the person closed.
const autoOpened = atom({ plugin: 'sessions', key: 'autoOpened' } as const, false)
const cloud = atom({ plugin: 'sessions', key: 'cloud' } as const, false)
// Session id to the id of the session that spawned it, null for none. Ids,
// not pids: a pid can be reused by a later session, a session id never is.
const parents = atom({ plugin: 'sessions', key: 'parents' } as const, {})
// Session id to the model its transcript named, so a transcript is no longer
// read once it has named one.
const models = atom({ plugin: 'sessions', key: 'models' } as const, {})
const folded = atom({ plugin: 'sessions', key: 'folded' } as const, {})
const showEnded = atom({ plugin: 'sessions', key: 'showEnded' } as const, true)
// A lookup that couldn't finish (process table unread, a session file mid-write,
// no model in the transcript yet) is tried again after this long, not every refresh.
const RETRY_MS = 60_000
// A failed table read is often just a busy machine, so it starts over soon,
// doubling up to RETRY_MS since each try costs a process.
const FIRST_PARENT_RETRY_MS = 5_000
const retryParent = new Map<string, { at: number; wait: number }>()
const retryModel = new Map<string, number>()
// What $.fs.read refuses: a long session's transcript passes it.
const READ_LIMIT = 4 * 1024 * 1024

// unreadable: the pids whose session file couldn't be read this time, so those
// sessions may still be running though missing from found.
type Listing = { found: SessionRow[]; problem: string; unreadable?: ReadonlySet<number> }

async function sessionsDir($: EngineInterface) {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config !== undefined && config !== '') return `${config.replace(/[\\/]+$/, '')}/sessions`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude/sessions`
}

const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

// undefined when the table couldn't be read: the command failed, or printed nothing usable.
async function processTable($: EngineInterface) {
  const argv = (await isWindows($))
    ? ['powershell', '-NoProfile', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId, $_.ParentProcessId -join ' ' }"]
    : ['ps', '-A', '-o', 'pid=,ppid=']
  const ran = await $.process.run(argv, { timeoutMs: 10_000 }).catch((err: unknown) => {
    $.ui.log(`sessions: process table: ${String(err)}`, { to: 'debug' })
    return undefined
  })
  const table = ran?.exitCode === 0 ? parseProcessTable(ran.stdout) : new Map<number, number>()
  if (ran !== undefined && table.size === 0) {
    $.ui.log(`sessions: process table unread (exit ${ran.exitCode}): ${ran.stderr.slice(0, 300)}`, { to: 'debug' })
  }
  return table.size > 0 ? table : undefined
}

// Session files don't name a parent, so the process table links a child to the
// session that spawned it. The link found when a session first appears is
// kept: rereading costs a process (PowerShell on Windows) and could lose the
// link once an intermediate shell exits and the child is reparented. "No
// parent" is kept only from a complete look: a failed table read, or a session
// file unreadable this refresh, is tried again, backing off to RETRY_MS.
async function linkParents($: EngineInterface, found: SessionRow[], unreadable: number) {
  if (found.length < 2) return found
  const known = await read($, parents)
  const at = await $.clock.now()
  const due = found.some(row => !(row.id in known) && (retryParent.get(row.id)?.at ?? 0) <= at)
  const table = due ? await processTable($) : undefined
  const idOfPid = new Map(found.flatMap(row => (row.pid === undefined ? [] : [[row.pid, row.id] as const])))
  const sessionPids = new Set(idOfPid.keys())
  const linked: Record<string, string | null> = {}
  for (const row of found) {
    if (row.id in known) {
      linked[row.id] = known[row.id] ?? null
      continue
    }
    const ancestor = table === undefined ? undefined : sessionAncestor(row.pid ?? -1, table, sessionPids)
    if (ancestor !== undefined) linked[row.id] = idOfPid.get(ancestor) ?? null
    else if (table !== undefined && unreadable === 0) linked[row.id] = null
    if (row.id in linked) retryParent.delete(row.id)
    else if (due) {
      const wait = retryParent.get(row.id)?.wait ?? FIRST_PARENT_RETRY_MS
      retryParent.set(row.id, { at: at + wait, wait: Math.min(wait * 2, RETRY_MS) })
    }
  }
  for (const id of retryParent.keys()) if (!found.some(row => row.id === id)) retryParent.delete(id)
  await update($, parents, () => linked)
  return found.map(row => ({ ...row, parent: linked[row.id] }))
}

// <app data>/Claude/claude-code-sessions/<org>/<user>/<host session id>.json,
// <app data> being %APPDATA% on Windows and ~/Library/Application Support on
// macOS; the desktop app has no Linux build.
async function desktopFolders($: EngineInterface) {
  const appData = await $.env.get('APPDATA')
  const home = await $.env.get('HOME')
  const base = appData ?? (home === undefined ? undefined : `${home}/Library/Application Support`)
  if (base === undefined) return []
  const subfolders = async (path: string) =>
    (await $.fs.list(path).catch(() => [])).filter(f => f.kind === 'dir').map(f => `${path}/${f.name}`)
  const orgs = await subfolders(`${base.replace(/[\\/]+$/, '')}/Claude/claude-code-sessions`)
  return (await Promise.all(orgs.map(subfolders))).flat()
}

// A transcript over READ_LIMIT is read from its end, where the latest reply is.
async function readTranscript($: EngineInterface, folder: string, name: string) {
  const path = `${folder}/${name}`
  const text = await $.fs.read(path).catch(() => undefined)
  if (text !== undefined) return text
  const entry = (await $.fs.list(folder).catch(() => [])).find(f => f.name === name)
  if (entry === undefined || entry.size <= READ_LIMIT) return undefined
  const argv = (await isWindows($))
    ? ['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail 500`]
    : ['tail', '-n', '500', path]
  const ran = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

// The desktop app's file names the model and the session that started this one
// (which runs under the app, not the parent, so the process table can't tell).
// Other sessions take the model from their transcript. shortcut: a transcript's
// model is kept once found, so a later /model never shows for those sessions;
// reread if that matters.
async function addDetails($: EngineInterface, found: SessionRow[], dir: string) {
  const folders = found.some(row => row.hostSessionId !== undefined) ? await desktopFolders($) : []
  const known = await read($, models)
  const at = await $.clock.now()
  const idOfHost = new Map(found.flatMap(row => (row.hostSessionId === undefined ? [] : [[row.hostSessionId, row.id] as const])))
  const learned: Record<string, string> = {}
  const detailed: SessionRow[] = []
  for (const row of found) {
    let desktop: ReturnType<typeof parseDesktopSession>
    for (const folder of row.hostSessionId === undefined ? [] : folders) {
      desktop = await $.fs.read(`${folder}/${row.hostSessionId}.json`).then(parseDesktopSession).catch(() => undefined)
      if (desktop !== undefined) break
    }
    let model = desktop?.model ?? known[row.id]
    if (model === undefined && (retryModel.get(row.id) ?? 0) <= at) {
      const text = await readTranscript($, `${dir.replace(/sessions$/, 'projects')}/${projectFolder(row.cwd)}`, `${row.id}.jsonl`)
      model = text === undefined ? undefined : transcriptModel(text)
      if (model === undefined) retryModel.set(row.id, at + RETRY_MS)
    }
    if (model !== undefined && desktop?.model === undefined) learned[row.id] = model
    const startedBy = desktop?.parentHost === undefined ? undefined : idOfHost.get(desktop.parentHost)
    detailed.push({ ...row, model, parent: startedBy ?? row.parent })
  }
  for (const id of retryModel.keys()) if (!found.some(row => row.id === id)) retryModel.delete(id)
  await update($, models, () => learned)
  return detailed
}

// full false: parents and models only as earlier refreshes stored them, so no
// process or transcript is read.
async function localRows($: EngineInterface, full: boolean): Promise<Listing> {
  const dir = await sessionsDir($)
  const found: SessionRow[] = []
  let problem = ''
  const unreadable = new Set<number>()
  try {
    if (dir === undefined) throw new Error('no home folder')
    const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    for (const file of files) {
      const row = await $.fs
        .read(`${dir}/${file.name}`)
        .then(parseSession)
        .catch(() => undefined)
      if (row !== undefined) found.push(row)
      else unreadable.add(Number(file.name.slice(0, -'.json'.length)))
    }
    if (files.length > 0 && found.length === 0) {
      problem = "Couldn't read any session file: Claude Code may have changed their format."
    }
  } catch {
    problem = `No session folder found${dir === undefined ? '' : ` at ${dir}`}.`
  }
  if (!full) {
    const [linked, named] = [await read($, parents), await read($, models)]
    return { found: found.map(row => ({ ...row, parent: linked[row.id], model: named[row.id] })), problem, unreadable }
  }
  const linked = await linkParents($, found, unreadable.size)
  return { found: dir === undefined ? linked : await addDetails($, linked, dir), problem, unreadable }
}

async function cloudRows($: EngineInterface): Promise<Listing> {
  const result = await $.mcp
    .call(REMOTE_SERVER, 'list_sessions', { mine: true, limit: CLOUD_LIMIT })
    .catch(() => undefined)
  if (result === undefined) return { found: [], problem: `Couldn't reach the ${REMOTE_SERVER} MCP server.` }
  if (result.isError) return { found: [], problem: 'The cloud session list failed to load.' }
  const found = parseCloudSessions(result.content.map(block => block.text ?? '').join(''))
  if (found === undefined) {
    return { found: [], problem: "Couldn't read the cloud session list: its format may have changed." }
  }
  // The page reaches further back than the history keeps.
  const at = await $.clock.now()
  return { found: found.filter(row => row.status === 'busy' || at - row.updatedAt <= HISTORY_MS), problem: '' }
}

// Every session on this machine shares the store, so each refresh merges into
// what any of them wrote last. shortcut: two refreshes racing can drop a row
// one of them added; the next refresh puts a running session back, an ended
// one is lost.
async function withHistory($: EngineInterface, found: SessionRow[], at: number, missing: (row: SessionRow) => Missing) {
  const kept = readHistory(await $.store.get(HISTORY_KEY).catch(() => undefined))
  const { history, rows: merged } = mergeHistory(kept, found, at, missing)
  await $.store.set(HISTORY_KEY, history).catch((err: unknown) => $.ui.log(`sessions: history not saved: ${String(err)}`, { to: 'debug' }))
  return merged
}

async function refresh($: EngineInterface, full = true) {
  const at = await $.clock.now()
  const isCloud = await read($, cloud)
  const { found, problem, unreadable } = isCloud ? await cloudRows($) : await localRows($, full)
  // A cloud session off the page is kept until it is HISTORY_MS old, like the
  // page itself; a local one ended unless its own file was the unreadable one.
  const missing = (row: SessionRow): Missing =>
    isCloud ? (at - row.updatedAt > HISTORY_MS ? 'drop' : 'keep') : row.pid !== undefined && unreadable?.has(row.pid) ? 'keep' : 'ended'
  // A listing that failed outright says nothing about which sessions ended.
  const listed = problem !== '' && found.length === 0 ? found : await withHistory($, found, at, missing)
  await update($, rows, () => sortRows(listed))
  await update($, error, () => problem)
  await update($, now, () => at)
}

// Hands the link to the OS, which passes it to the desktop app.
async function openLink($: EngineInterface, url: string) {
  const argv =
    (await $.env.get('OS')) === 'Windows_NT' ? ['cmd', '/c', 'start', '', url] : ['open', url]
  const ran = await $.process.run(argv).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) $.ui.toast("Couldn't open that session in the desktop app.")
}

// The pane opens from a quick refresh; parents and models that need a process
// or transcript read follow on a timer, so neither a session's start nor
// /sessions waits on them.
async function openQuickly($: EngineInterface) {
  await refresh($, false)
  // A cloud row has no parent or model to fill in.
  if (!(await read($, cloud))) $.clock.after(0, () => refresh($))
}

// Module variable on purpose: a reload drops timers, and session.start
// restarts the refresh when the pane is still up.
let ticking: Timer | undefined

const isPaneUp = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

async function startTicking($: EngineInterface) {
  const period = (await read($, cloud)) ? CLOUD_REFRESH_MS : REFRESH_MS
  if (ticking !== undefined) return
  ticking = $.clock.every(period, async () => {
    if (!(await isPaneUp($))) {
      ticking?.cancel()
      ticking = undefined
      return
    }
    await refresh($)
  })
}

// Once per session: the desktop app attaches again on every reconnect. Cloud
// sessions are skipped: there each refresh is an API call, so the pane waits
// for /sessions.
async function autoOpen($: EngineInterface) {
  if (await read($, cloud)) return
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  await openQuickly($)
  // Unfocused, so the prompt keeps the keyboard. Unasked, the engine draws a
  // pane only from 144 columns, or 110 once /sessions has opened it; narrower,
  // it waits for /sessions.
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  if (!opened.isPlaced) $.ui.log(`sessions: pane not drawn on auto-open: ${opened.reason}`, { to: 'debug' })
  await startTicking($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Open the Sessions pane: running sessions and their status',
      immediate: true,
    })
    const isCloud = (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'
    await update($, cloud, () => isCloud)
    const remoteId = await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')
    const id = isCloud && remoteId !== undefined ? cloudSessionId(remoteId) : await $.session.id()
    await update($, sessionId, () => id)
    if (await isPaneUp($).catch(() => false)) {
      await openQuickly($)
      await startTicking($)
    }
    if (e.surface === 'terminal') await autoOpen($)

    return next(e)
  })

  // The desktop app runs the session headless: at session.start nothing draws
  // yet, so its first chance at the pane is when it attaches. Opened after
  // next, once the app is on the session's roster of surfaces.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (e.surface === 'desktop') await autoOpen($)
    return attached
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await openQuickly($)
    // Focused on open: unfocused, Switch took two clicks in the desktop app,
    // likely the first giving the pane focus.
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    await startTicking($)

    // Say when no surface draws it (#14), rather than claim it opened.
    if (!opened.isPlaced) return { text: `Sessions pane is open but not drawn: ${opened.reason}` }
    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const all = await read($, rows)
    const ended = all.filter(row => row.status === 'ended').length
    const isShowingEnded = await read($, showEnded)
    const list = isShowingEnded ? all : all.filter(row => row.status !== 'ended')
    const foldedIds = await read($, folded)
    const current = await read($, sessionId)
    const at = await read($, now)
    const problem = await read($, error)
    // Cloud sessions stay listed after they stop: recent ones, not running ones.
    const kind = (await read($, cloud)) ? 'recent' : 'running'
    const working = all.filter(row => row.status === 'busy').length
    const live = all.length - ended
    const days = Math.round(HISTORY_MS / 86_400_000)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>{live} {kind}</Text>
          <Text dimColor>· {working} working</Text>
          {ended > 0 ? <Text dimColor>· {ended} ended</Text> : null}
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          {ended > 0 ? (
            <Button
              key="ended"
              label={isShowingEnded ? 'Hide ended' : 'Show ended'}
              onPress={() => update($, showEnded, isShown => !isShown)}
            />
          ) : null}
        </Box>
        {problem !== '' ? <Text color="error">{problem}</Text> : null}
        {problem === '' && all.length === 0 ? <Text dimColor>No {kind} sessions found.</Text> : null}
        {ended > 0 && isShowingEnded ? <Text dimColor>Ended sessions stay listed for {days} days.</Text> : null}
        {foldRows(nestRows(list), foldedIds).map(({ row, depth, under, isFolded }) => {
          const { dot, label, color, isDim } = look(row, at)
          const link = row.id === current ? undefined : switchLink(row)
          return (
            <Box key={row.id} flexDirection="column" paddingLeft={depth * 2}>
              <Box flexDirection="row" gap={1}>
                {depth > 0 ? <Text dimColor>└</Text> : null}
                <Text color={color} dimColor={isDim}>{dot}</Text>
                <Text bold={row.id === current} dimColor={isDim}>{row.name}</Text>
                {under > 0 ? (
                  <Button
                    key={`fold:${row.id}`}
                    label={`${isFolded ? '▸' : '▾'} ${under}`}
                    onPress={() => update($, folded, ids => ({ ...ids, [row.id]: !isFolded }))}
                  />
                ) : null}
                {link !== undefined && row.status !== 'ended' ? (
                  <Button key={`switch:${row.id}`} label="Switch" onPress={() => openLink($, link)} />
                ) : null}
                {row.url !== undefined && row.id !== current ? <Link href={row.url} label="Open" /> : null}
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text color={color} dimColor={isDim}>  {label}</Text>
                <Text dimColor>· {ago(at - row.updatedAt)}</Text>
                {row.model !== undefined ? <Text dimColor>· {row.model}</Text> : null}
                {row.id === current ? <Text dimColor>· this session</Text> : null}
              </Box>
              {row.needs !== undefined ? <Text dimColor>  {row.needs}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
