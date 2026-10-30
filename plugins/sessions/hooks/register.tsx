import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SessionRow } from '../types'
import {
  ago,
  cloudSessionId,
  look,
  nestRows,
  parseCloudSessions,
  parseDesktopSession,
  parseProcessTable,
  parseSession,
  projectFolder,
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
const CLOUD_LIMIT = 10

const rows = atom({ plugin: 'sessions', key: 'rows' } as const, [])
const sessionId = atom({ plugin: 'sessions', key: 'sessionId' } as const, '')
const now = atom({ plugin: 'sessions', key: 'now' } as const, 0)
const error = atom({ plugin: 'sessions', key: 'error' } as const, '')
// In $.state, not a module variable: a reload fires session.start again and
// must not reopen a pane the person closed.
const autoOpened = atom({ plugin: 'sessions', key: 'autoOpened' } as const, false)
const cloud = atom({ plugin: 'sessions', key: 'cloud' } as const, false)
// Session id to the pid of the session that spawned it, null for none. Keyed
// by session, not pid, so a reused pid is looked up afresh.
const parents = atom({ plugin: 'sessions', key: 'parents' } as const, {})
// Session id to the model its transcript named, so a transcript is read once.
const models = atom({ plugin: 'sessions', key: 'models' } as const, {})

type Listing = { found: SessionRow[]; problem: string }

async function sessionsDir($: EngineInterface) {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config !== undefined && config !== '') return `${config.replace(/[\\/]+$/, '')}/sessions`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude/sessions`
}

async function processTable($: EngineInterface) {
  const argv =
    (await $.env.get('OS')) === 'Windows_NT'
      ? ['powershell', '-NoProfile', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId, $_.ParentProcessId -join ' ' }"]
      : ['ps', '-A', '-o', 'pid=,ppid=']
  const ran = await $.process.run(argv).catch(() => undefined)
  return parseProcessTable(ran?.stdout ?? '')
}

// Session files don't name a parent, so the process table links a child to the
// session that spawned it. Ancestry never changes, so the table is read only
// when a new session appears. shortcut: a failed read leaves those sessions
// flat for good, retry if that shows up in practice.
async function linkParents($: EngineInterface, found: SessionRow[]) {
  if (found.length < 2) return found
  const known = await read($, parents)
  const table = found.some(row => !(row.id in known)) ? await processTable($) : new Map<number, number>()
  const sessionPids = new Set(found.flatMap(row => row.pid ?? []))
  const linked: Record<string, number | null> = {}
  for (const row of found) {
    linked[row.id] = known[row.id] ?? (row.id in known ? null : (sessionAncestor(row.pid ?? -1, table, sessionPids) ?? null))
  }
  await update($, parents, () => linked)
  return found.map(row => ({ ...row, parent: linked[row.id] ?? undefined }))
}

// <app data>/Claude/claude-code-sessions/<org>/<user>/<host session id>.json
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

// The desktop app's file names the model and the session that started this one
// (which runs under the app, not the parent, so the process table can't tell).
// Other sessions take the model from their transcript. shortcut: a transcript's
// model is kept once found, so /model in a terminal session shows late, reread
// if that matters.
async function addDetails($: EngineInterface, found: SessionRow[], dir: string) {
  const folders = found.some(row => row.hostSessionId !== undefined) ? await desktopFolders($) : []
  const known = await read($, models)
  const pidOfHost = new Map(found.map(row => [row.hostSessionId, row.pid]))
  const learned: Record<string, string> = {}
  const detailed: SessionRow[] = []
  for (const row of found) {
    let desktop: ReturnType<typeof parseDesktopSession>
    for (const folder of row.hostSessionId === undefined ? [] : folders) {
      desktop = await $.fs.read(`${folder}/${row.hostSessionId}.json`).then(parseDesktopSession).catch(() => undefined)
      if (desktop !== undefined) break
    }
    const model =
      desktop?.model ??
      known[row.id] ??
      (await $.fs
        .read(`${dir.replace(/sessions$/, 'projects')}/${projectFolder(row.cwd)}/${row.id}.jsonl`)
        .then(transcriptModel)
        .catch(() => undefined))
    if (model !== undefined && desktop?.model === undefined) learned[row.id] = model
    const startedBy = desktop?.parentHost === undefined ? undefined : pidOfHost.get(desktop.parentHost)
    detailed.push({ ...row, model, parent: startedBy ?? row.parent })
  }
  await update($, models, () => learned)
  return detailed
}

async function localRows($: EngineInterface): Promise<Listing> {
  const dir = await sessionsDir($)
  const found: SessionRow[] = []
  let problem = ''
  try {
    if (dir === undefined) throw new Error('no home folder')
    const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    for (const file of files) {
      const row = await $.fs
        .read(`${dir}/${file.name}`)
        .then(parseSession)
        .catch(() => undefined)
      if (row !== undefined) found.push(row)
    }
    if (files.length > 0 && found.length === 0) {
      problem = "Couldn't read any session file: Claude Code may have changed their format."
    }
  } catch {
    problem = `No session folder found${dir === undefined ? '' : ` at ${dir}`}.`
  }
  const linked = await linkParents($, found)
  return { found: dir === undefined ? linked : await addDetails($, linked, dir), problem }
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
  return { found, problem: '' }
}

async function refresh($: EngineInterface) {
  const at = await $.clock.now()
  const { found, problem } = (await read($, cloud)) ? await cloudRows($) : await localRows($)
  await update($, rows, () => sortRows(found))
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
  await refresh($)
  // Unfocused, so the prompt keeps the keyboard. Unasked, the engine draws a
  // pane only from 144 columns, or 110 once /sessions has opened it; narrower,
  // it waits for /sessions.
  await $.ui.open({ id: PANE, title: PANE_TITLE })
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
      await refresh($)
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
    await refresh($)
    // Focused on open: unfocused, Switch took two clicks in the desktop app,
    // likely the first giving the pane focus.
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    await startTicking($)

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const current = await read($, sessionId)
    const at = await read($, now)
    const problem = await read($, error)
    // Cloud sessions stay listed after they stop: recent ones, not running ones.
    const kind = (await read($, cloud)) ? 'recent' : 'running'
    const working = list.filter(row => row.status === 'busy').length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>{list.length} {kind}</Text>
          <Text dimColor>· {working} working</Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
        {problem !== '' ? <Text color="error">{problem}</Text> : null}
        {problem === '' && list.length === 0 ? <Text dimColor>No {kind} sessions found.</Text> : null}
        {nestRows(list).map(({ row, depth }) => {
          const { dot, label, color, isDim } = look(row, at)
          const link = row.id === current ? undefined : switchLink(row)
          return (
            <Box key={row.id} flexDirection="column" paddingLeft={depth * 2}>
              <Box flexDirection="row" gap={1}>
                {depth > 0 ? <Text dimColor>└</Text> : null}
                <Text color={color} dimColor={isDim}>{dot}</Text>
                <Text bold={row.id === current} dimColor={isDim}>{row.name}</Text>
                {link !== undefined ? (
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
