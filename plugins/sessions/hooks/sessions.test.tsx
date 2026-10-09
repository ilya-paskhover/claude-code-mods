import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, look, parseSession, sortRows, STALE_MS } from './parse'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = { component: 'Pane', requestId: 'sessions', props: {} as never } as const
// The engine hands fs hooks the path with the platform's separators.
const DIR = 'C:/Users/dev/.claude/sessions'
const slashed = (e: unknown) => (e as { path: string }).path.replace(/\\/g, '/')
const NOW = Date.UTC(2026, 9, 9, 12, 0)

const file = (pid: number, fields: Record<string, unknown>) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: `C:\\work\\p${pid}`, status: 'idle', updatedAt: NOW, ...fields })

const setup = (on: On, files: Record<string, string>) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\dev' })
  const panes: { id: string }[] = []
  let lists = 0
  on('fs.list', ($, e) => {
    lists++
    if (slashed(e) !== DIR) throw new Error('ENOENT')
    return { value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', ($, e) => {
    const name = slashed(e).slice(DIR.length + 1)
    if (!(name in files)) throw new Error('ENOENT')
    return { value: files[name] } as never
  })
  on('ui.open', ($, e) => {
    panes.push({ id: (e as { id: string }).id })
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: panes.map(p => ({ ...p, title: 'Sessions', isShown: true, isFocused: false })) }) as never)
  on('session.id', () => ({ value: 's-2' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  return { clock, panes, lists: () => lists }
}

test('parse reads the fields it needs and refuses what it cannot use', () => {
  expect(parseSession(file(7, { name: 'Fix login' }))).toEqual({
    id: 's-7', pid: 7, cwd: 'C:\\work\\p7', name: 'Fix login', status: 'idle', updatedAt: NOW, entrypoint: undefined,
  })
  expect(parseSession(file(7, {}))!.name).toBe('p7')
  expect(parseSession('{not json')).toBeUndefined()
  expect(parseSession(JSON.stringify({ pid: 1 }))).toBeUndefined()
})

test('sort puts working sessions first, then the most recent, one row per session', () => {
  const a = parseSession(file(1, { updatedAt: NOW - 5_000 }))!
  const b = parseSession(file(2, { updatedAt: NOW - 60_000, status: 'busy' }))!
  const c = parseSession(file(3, { updatedAt: NOW }))!
  const older = { ...c, updatedAt: NOW - 1 }
  expect(sortRows([a, older, b, c]).map(r => r.id)).toEqual(['s-2', 's-3', 's-1'])
})

test('ago and look', () => {
  expect([ago(10_000), ago(5 * 60_000), ago(3 * 3_600_000), ago(2 * 86_400_000)]).toEqual(['now', '5m', '3h', '2d'])
  const busy = parseSession(file(1, { status: 'busy' }))!
  expect(look(busy, NOW).label).toBe('working')
  expect(look(busy, NOW + STALE_MS + 1)).toMatchObject({ label: 'working?', isDim: true })
  expect(look({ ...busy, status: 'waiting' }, NOW).label).toBe('waiting')
})

test('/sessions lists every running session with status, folder and age', async ($, on) => {
  setup(on, {
    '1.json': file(1, { name: 'Fix login', updatedAt: NOW - 2 * 60_000 }),
    '2.json': file(2, { name: 'Publish mods', status: 'busy' }),
    '3.json': '{broken',
    '1.abc.key': 'not a session',
  })
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  const ran = await $.command.run({ command: 'sessions', args: '' } as never)
  expect((ran as { text: string }).text).toBe('Sessions pane opened.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sessions', surface, ...PANE })
    expect(await ui.findAll({ type: 'Text', text: /^2 running$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^· 1 working$/ })).toHaveLength(1)
    const names = await ui.findAll({ type: 'Text', text: /^(Fix login|Publish mods)$/ })
    expect(names.map(n => (n as { text: string }).text)).toEqual(['Publish mods', 'Fix login'])
    expect(await ui.findAll({ type: 'Text', text: /^\s*working$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^· 2m$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^· p1$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^· this session$/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('the pane refreshes on a timer while it is open', async ($, on) => {
  const files: Record<string, string> = { '1.json': file(1, {}) }
  const { clock, panes, lists } = setup(on, files)
  await $.session.start({ source: 'startup', cwd: 'C:/work/p1' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)

  files['4.json'] = file(4, { name: 'New one', status: 'busy' })
  await clock.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /^New one$/ })).toHaveLength(1)
  await ui.unmount()

  panes.length = 0
  await clock.advance(5_000)
  const after = lists()
  await clock.advance(20_000)
  expect(lists()).toBe(after)
})

test('says so when no file can be read or the folder is missing', async ($, on) => {
  setup(on, { '1.json': '{"renamed": true}' })
  await $.session.start({ source: 'startup', cwd: 'C:/work/p1' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /changed their format/ })).toHaveLength(1)
  await ui.unmount()
})

test('a missing sessions folder is reported, not thrown', async ($, on) => {
  mock.env(on, { HOME: '/home/dev' })
  mock.clock(on, { now: NOW })
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('session.id', () => ({ value: 's-1' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /No session folder found at \/home\/dev\/.claude\/sessions/ })).toHaveLength(1)
  await ui.unmount()
})
