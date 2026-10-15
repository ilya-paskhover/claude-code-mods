import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SessionRow } from '../types'
import { ago, look, parseSession, sortRows, switchLink } from './parse'

// Claude Code writes one <pid>.json per running session into its config
// folder's sessions/ directory. That file is the engine's own, not mod API.
const PANE = 'sessions'
const PANE_TITLE = 'Sessions'
const REFRESH_MS = 5_000

const rows = atom({ plugin: 'sessions', key: 'rows' } as const, [])
const sessionId = atom({ plugin: 'sessions', key: 'sessionId' } as const, '')
const now = atom({ plugin: 'sessions', key: 'now' } as const, 0)
const error = atom({ plugin: 'sessions', key: 'error' } as const, '')
// In $.state, not a module variable: a reload fires session.start again and
// must not reopen a pane the person closed.
const autoOpened = atom({ plugin: 'sessions', key: 'autoOpened' } as const, false)

async function sessionsDir($: EngineInterface) {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config !== undefined && config !== '') return `${config.replace(/[\\/]+$/, '')}/sessions`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude/sessions`
}

async function refresh($: EngineInterface) {
  const at = await $.clock.now()
  const dir = await sessionsDir($)
  let found: SessionRow[] = []
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
  found = sortRows(found)
  await update($, rows, () => found)
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

function startTicking($: EngineInterface) {
  if (ticking !== undefined) return
  ticking = $.clock.every(REFRESH_MS, async () => {
    if (!(await isPaneUp($))) {
      ticking?.cancel()
      ticking = undefined
      return
    }
    await refresh($)
  })
}

// Once per session: the desktop app attaches again on every reconnect. Cloud
// sessions are skipped; the pane lists this machine's sessions only.
async function autoOpen($: EngineInterface) {
  if ((await $.env.get('CLAUDE_CODE_REMOTE')) === 'true') return
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  await refresh($)
  // Unfocused, so the prompt keeps the keyboard. Unasked, the engine draws a
  // pane only from 144 columns; narrower, it waits for /sessions.
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  startTicking($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Open the Sessions pane: running sessions and their status',
      immediate: true,
    })
    const id = await $.session.id()
    await update($, sessionId, () => id)
    if (await isPaneUp($).catch(() => false)) {
      await refresh($)
      startTicking($)
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
    startTicking($)

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const current = await read($, sessionId)
    const at = await read($, now)
    const problem = await read($, error)
    const working = list.filter(row => row.status === 'busy').length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>{list.length} running</Text>
          <Text dimColor>· {working} working</Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
        {problem !== '' ? <Text color="error">{problem}</Text> : null}
        {problem === '' && list.length === 0 ? <Text dimColor>No running sessions found.</Text> : null}
        {list.map(row => {
          const { dot, label, color, isDim } = look(row, at)
          const link = row.id === current ? undefined : switchLink(row)
          return (
            <Box key={row.id} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={color} dimColor={isDim}>{dot}</Text>
                <Text bold={row.id === current} dimColor={isDim}>{row.name}</Text>
                {link !== undefined ? (
                  <Button key={`switch:${row.id}`} label="Switch" onPress={() => openLink($, link)} />
                ) : null}
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text color={color} dimColor={isDim}>  {label}</Text>
                <Text dimColor>· {ago(at - row.updatedAt)}</Text>
                {row.id === current ? <Text dimColor>· this session</Text> : null}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
