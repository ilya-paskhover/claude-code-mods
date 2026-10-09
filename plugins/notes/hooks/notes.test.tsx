import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clean, compose, preview } from './compose'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = { component: 'Pane', requestId: 'notes', props: {} as never } as const

const setup = (on: On) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 9, 12, 0) })
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('session.cwd', () => ({ value: 'C:\\work\\project' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  return { store }
}

test('compose: a selection is the note and typed text its comment', () => {
  expect(compose({ text: '  picked  ', requestId: 'row-7' }, ' why ')).toEqual({
    text: 'picked',
    comment: 'why',
    requestId: 'row-7',
  })
  expect(compose({ text: 'picked' }, '')).toEqual({ text: 'picked', comment: undefined, requestId: undefined })
  expect(compose(undefined, ' typed ')).toEqual({ text: 'typed' })
  expect(compose({ text: '   ' }, 'typed')).toEqual({ text: 'typed' })
  expect(compose(undefined, '  ')).toBeUndefined()
})

test('/note saves typed text with time and folder, newest first', async ($, on) => {
  const { store } = setup(on)
  await $.session.start({ source: 'startup', cwd: 'C:/work/project' } as never)

  await $.command.run({ command: 'note', args: 'first' } as never)
  const ran = await $.command.run({ command: 'note', args: 'second' } as never)

  expect((ran as { text: string }).text).toBe('Noted: second')
  const saved = store.get('notes') as { text: string; cwd: string; sessionId: string; done: boolean }[]
  expect(saved.map(n => n.text)).toEqual(['second', 'first'])
  expect(saved[0]!.cwd).toBe('C:\\work\\project')
  expect(saved[0]!.sessionId).toBe('session-1')
  expect(saved[0]!.done).toBe(false)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'notes', surface, ...PANE })
    expect(await ui.findAll({ type: 'Text', text: /^2 open$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^project$/ })).toHaveLength(2)
    expect(await ui.findAll({ type: 'Markdown', text: /^second$/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('/note with nothing selected or typed saves nothing', async ($, on) => {
  const { store } = setup(on)
  await $.session.start({ source: 'startup', cwd: 'C:/work/project' } as never)

  const ran = await $.command.run({ command: 'note', args: '  ' } as never)

  expect((ran as { text: string }).text).toContain('Nothing to save')
  expect(store.get('notes')).toBeUndefined()
})

test('checking a note marks it done, hides it, and Clear done removes it', async ($, on) => {
  const { store } = setup(on)
  await $.session.start({ source: 'startup', cwd: 'C:/work/project' } as never)
  await $.command.run({ command: 'note', args: 'keep me' } as never)
  await $.command.run({ command: 'note', args: 'finish me' } as never)
  const finishId = (store.get('notes') as { id: string }[])[0]!.id

  const ui = await $.ui.mount({ plugin: 'notes', surface: 'terminal', ...PANE })
  await ui.press({ key: `done-${finishId}` })
  expect((store.get('notes') as { done: boolean }[]).map(n => n.done)).toEqual([true, false])
  expect(await ui.findAll({ type: 'Text', text: /^1 open$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Markdown', text: /finish me/ })).toHaveLength(0)

  await ui.press({ key: 'toggle-done' })
  expect(await ui.findAll({ type: 'Markdown', text: /finish me/ })).toHaveLength(1)

  await ui.press({ key: 'clear-done' })
  expect((store.get('notes') as { text: string }[]).map(n => n.text)).toEqual(['keep me'])
  await ui.unmount()
})

const lines = (...parts: string[]) => parts.join('\n')

test('clean strips the pasted_content wrapper', () => {
  const body = lines('My suggestion', '', '```', 'rm -rf x', '```')
  const pasted = lines('<pasted_content id="17ca">', body, '</pasted_content id="17ca">')
  expect(clean(pasted)).toBe(body)
  expect(compose(undefined, pasted)).toEqual({ text: body })
})

test('preview keeps short notes whole and closes a code fence it cuts', () => {
  expect(preview(lines('one', 'two'))).toEqual({ text: lines('one', 'two'), isCut: false })
  const cut = preview(lines('intro', '```', 'a', 'b', 'c', 'd', 'e', 'f', '```'))
  expect(cut.isCut).toBe(true)
  expect(cut.text).toBe(lines('intro', '```', 'a', 'b', 'c', 'd', '```'))
})

test('a long note draws as markdown with More and Less', async ($, on) => {
  setup(on)
  await $.session.start({ source: 'startup', cwd: 'C:/work/project' } as never)
  const long = lines('line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7 hidden')
  await $.command.run({ command: 'note', args: long } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'notes', surface, ...PANE })
    expect(await ui.findAll({ type: 'Markdown', text: /line 7 hidden/ })).toHaveLength(0)
    const [more] = await ui.findAll({ type: 'Button', text: /^More$/ })
    expect(more).toBeDefined()
    await ui.press({ key: (more as { key: string }).key })
    expect(await ui.findAll({ type: 'Markdown', text: /line 7 hidden/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Button', text: /^Less$/ })).toHaveLength(1)
    await ui.press({ key: (more as { key: string }).key })
    await ui.unmount()
  }
})
