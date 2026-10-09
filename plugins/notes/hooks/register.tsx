import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note } from '../types'
import { clean, compose, preview } from './compose'

// The list lives in $.store so every session and project shares it; the
// atom mirrors it for drawing.
const STORE_KEY = 'notes'
const PANE = 'notes'
const PANE_TITLE = 'Notes'

const notes = atom({ plugin: 'notes', key: 'notes' } as const, [])
const showDone = atom({ plugin: 'notes', key: 'showDone' } as const, false)
const sessionId = atom({ plugin: 'notes', key: 'sessionId' } as const, '')
const expanded = atom({ plugin: 'notes', key: 'expanded' } as const, [])

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const formatWhen = (ms: number) => {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const asNotes = (value: unknown): Note[] => (Array.isArray(value) ? (value as Note[]) : [])

// Re-reads the store before every change, so two sessions writing in turn
// both keep their notes.
async function change($: EngineInterface, fn: (list: Note[]) => Note[]) {
  const next = fn(asNotes(await $.store.get(STORE_KEY)))
  await $.store.set(STORE_KEY, next)
  await update($, notes, () => next)
  return next
}

async function reload($: EngineInterface) {
  const list = asNotes(await $.store.get(STORE_KEY))
  await update($, notes, () => list)
}

async function openPane($: EngineInterface) {
  await reload($)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'note',
      description: 'Save the selected text (plus an optional comment) to Notes',
      argumentHint: '[comment, or the text to save]',
      immediate: true,
    })
    await $.command.register({ name: 'notes', description: 'Open the Notes pane', immediate: true })
    const id = await $.session.id()
    await update($, sessionId, () => id)
    await reload($)

    return next(e)
  })

  on('command.run', { command: 'notes' }, async $ => {
    await openPane($)

    return { text: 'Notes pane opened.' }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    // Not every surface reads a selection: then /note takes typed text only.
    let selection: { text: string; requestId?: string } | undefined
    try {
      selection = await $.ui.selection()
    } catch {
      selection = undefined
    }
    const composed = compose(selection, e.args)
    if (composed === undefined) {
      return { text: 'Nothing to save: select text in the chat first, or type /note <text>.' }
    }

    const now = await $.clock.now()
    const note: Note = {
      ...composed,
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      cwd: await $.session.cwd(),
      sessionId: await $.session.id(),
      done: false,
    }
    await change($, list => [note, ...list])
    await openPane($)

    const firstLine = note.text.split('\n')[0] ?? ''
    return { text: `Noted: ${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const list = await read($, notes)
    const isShowingDone = await read($, showDone)
    const current = await read($, sessionId)
    const expandedIds = await read($, expanded)
    const open = list.filter(note => !note.done)
    const done = list.filter(note => note.done)
    const shown = isShowingDone ? [...open, ...done] : open

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>{open.length} open</Text>
          <Text dimColor>· {done.length} done</Text>
          {done.length > 0 ? (
            <Button
              key="toggle-done"
              label={isShowingDone ? 'Hide done' : 'Show done'}
              onPress={() => update($, showDone, value => !value)}
            />
          ) : null}
          {done.length > 0 ? (
            <Button
              key="clear-done"
              label="Clear done"
              onPress={() => change($, all => all.filter(note => !note.done))}
            />
          ) : null}
        </Box>
        {list.length === 0 ? (
          <Text dimColor>No notes yet. Select text in the chat and type /note.</Text>
        ) : null}
        {open.length === 0 && done.length > 0 && !isShowingDone ? (
          <Text dimColor>All done.</Text>
        ) : null}
        {shown.map(note => (
          <Box key={note.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button
                key={`done-${note.id}`}
                label={note.done ? '☑' : '☐'}
                onPress={async () => {
                  const at = await $.clock.now()
                  await change($, all =>
                    all.map(one =>
                      one.id === note.id
                        ? { ...one, done: !one.done, doneAt: one.done ? undefined : at }
                        : one,
                    ),
                  )
                }}
              />
              <Text dimColor>{formatWhen(note.createdAt)}</Text>
              <Text color="suggestion">{folderName(note.cwd)}</Text>
              {note.sessionId === current && note.requestId !== undefined ? (
                <Button
                  key={`jump-${note.id}`}
                  label="Jump"
                  onPress={() => $.ui.scroll({ to: { requestId: note.requestId! }, block: 'center' })}
                />
              ) : null}
              <Button
                key={`delete-${note.id}`}
                label="Delete"
                onPress={() => change($, all => all.filter(one => one.id !== note.id))}
              />
            </Box>
            {(() => {
              const isOpen = expandedIds.includes(note.id)
              const cut = preview(clean(note.text))
              return (
                <Box flexDirection="column">
                  <Markdown text={isOpen ? clean(note.text) : cut.text} dimColor={note.done} />
                  {cut.isCut ? (
                    <Button
                      key={`more-${note.id}`}
                      label={isOpen ? 'Less' : 'More'}
                      onPress={() =>
                        update($, expanded, ids =>
                          ids.includes(note.id) ? ids.filter(id => id !== note.id) : [...ids, note.id],
                        )
                      }
                    />
                  ) : null}
                </Box>
              )
            })()}
            {note.comment !== undefined ? (
              <Text italic dimColor={note.done}>↳ {note.comment}</Text>
            ) : null}
          </Box>
        ))}
      </Box>
    )
  })
}
