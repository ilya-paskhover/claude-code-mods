import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SessionRow } from '../types'
import { ago, firstLine, folderName, look, parseSession, sortRows } from './parse'

// Claude Code writes one <pid>.json per running session into its config
// folder's sessions/ directory. That file is the engine's own, not mod API.
const PANE = 'sessions'
const PANE_TITLE = 'Sessions'
const REFRESH_MS = 5_000

const rows = atom({ plugin: 'sessions', key: 'rows' } as const, [])
const sessionId = atom({ plugin: 'sessions', key: 'sessionId' } as const, '')
const now = atom({ plugin: 'sessions', key: 'now' } as const, 0)
const error = atom({ plugin: 'sessions', key: 'error' } as const, '')

// The notes mod's list, read-only: mod panes open as tabs of one pane (#5),
// so the open notes are shown here too. Undefined when notes isn't loaded.
const notesRef = { plugin: 'notes', key: 'notes' } as const
const NOTES_SHOWN = 8

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

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })
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
    const allNotes = (await $.state.get(notesRef))?.value
    const openNotes = (allNotes ?? []).filter(note => !note.done)

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
          return (
            <Box key={row.id} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={color} dimColor={isDim}>{dot}</Text>
                <Text bold={row.id === current} dimColor={isDim}>{row.name}</Text>
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text color={color} dimColor={isDim}>  {label}</Text>
                <Text dimColor>· {ago(at - row.updatedAt)}</Text>
                <Text color="suggestion" dimColor={isDim}>· {folderName(row.cwd)}</Text>
                {row.id === current ? <Text dimColor>· this session</Text> : null}
              </Box>
            </Box>
          )
        })}
        {allNotes !== undefined ? (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color="claude" bold>{openNotes.length} open notes</Text>
              <Text dimColor>· /notes to edit</Text>
            </Box>
            {openNotes.slice(0, NOTES_SHOWN).map(note => (
              <Box key={`note-${note.id}`} flexDirection="row" gap={1}>
                <Text color="suggestion">{folderName(note.cwd)}</Text>
                <Text>{firstLine(note.text)}</Text>
              </Box>
            ))}
            {openNotes.length > NOTES_SHOWN ? (
              <Text dimColor>+{openNotes.length - NOTES_SHOWN} more</Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
