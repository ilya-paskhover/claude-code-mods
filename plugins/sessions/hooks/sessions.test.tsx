import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, cloudSessionId, look, parseCloudSessions, parseSession, sortRows, STALE_MS } from './parse'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = { component: 'Pane', requestId: 'sessions', props: {} as never } as const
// The engine hands fs hooks the path with the platform's separators. Off Windows,
// C:/ is not absolute, so the engine prefixes the mod folder; drop that prefix.
const DIR = 'C:/Users/dev/.claude/sessions'
const slashed = (e: unknown) => {
  const path = (e as { path: string }).path.replace(/\\/g, '/')
  const at = path.indexOf('C:/')
  return at < 0 ? path : path.slice(at)
}
const NOW = Date.UTC(2026, 9, 9, 12, 0)

const file = (pid: number, fields: Record<string, unknown>) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: `C:\\work\\p${pid}`, status: 'idle', updatedAt: NOW, ...fields })

const setup = (on: On, files: Record<string, string>, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\dev', ...env })
  const panes: { id: string }[] = []
  const opens: { id: string; focus?: boolean }[] = []
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
    const { id, focus } = e as { id: string; focus?: boolean }
    opens.push({ id, focus })
    panes.push({ id })
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: panes.map(p => ({ ...p, title: 'Sessions', isShown: true, isFocused: false })) }) as never)
  on('session.id', () => ({ value: 's-2' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.attach', ($, e) => ({ clientId: (e as { clientId: string }).clientId }) as never)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return { clock, panes, opens, runs, lists: () => lists }
}

const attach = (surface: 'desktop' | 'mobile') => ({ surface, clientId: `${surface}:default` }) as never

test('parse reads the fields it needs and refuses what it cannot use', () => {
  expect(parseSession(file(7, { name: 'Fix login' }))).toEqual({
    id: 's-7', pid: 7, cwd: 'C:\\work\\p7', name: 'Fix login', status: 'idle', updatedAt: NOW, hostSessionId: undefined,
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

test('/sessions lists every running session with status and age, no folder', async ($, on) => {
  setup(on, {
    '1.json': file(1, { name: 'Fix login', updatedAt: NOW - 2 * 60_000 }),
    '2.json': file(2, { name: 'Publish mods', status: 'busy', hostSessionId: 'local_2' }),
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
    expect(await ui.findAll({ type: 'Text', text: /^· p[12]$/ })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Text', text: /^· this session$/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('Switch opens a desktop session from its link, never this one or a terminal one', async ($, on) => {
  const { runs } = setup(on, {
    '1.json': file(1, { name: 'Desktop one', hostSessionId: 'local_1' }),
    '2.json': file(2, { name: 'This one', hostSessionId: 'local_2' }),
    '3.json': file(3, { name: 'Terminal one' }),
  })
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sessions', surface, ...PANE })
    const keys = (await ui.findAll({ type: 'Button' })).map(b => (b as { key: string }).key)
    expect(keys.filter(key => key.startsWith('switch:'))).toEqual(['switch:s-1'])
    await ui.press({ key: 'switch:s-1' })
    await ui.unmount()
  }
  expect(runs).toEqual([
    ['open', 'claude://claude.ai/epitaxy/local_1'],
    ['open', 'claude://claude.ai/epitaxy/local_1'],
  ])
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

test('a terminal session opens the pane unfocused, once, and a reload keeps it closed', async ($, on) => {
  const { panes, opens } = setup(on, { '1.json': file(1, { name: 'Fix login' }) })
  await $.session.start({ source: 'startup', cwd: 'C:/work/p1', surface: 'terminal' } as never)
  expect(opens).toEqual([{ id: 'sessions', focus: undefined }])
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /^Fix login$/ })).toHaveLength(1)
  await ui.unmount()

  panes.length = 0
  await $.session.start({ source: 'startup', cwd: 'C:/work/p1', surface: 'terminal' } as never)
  expect(opens).toHaveLength(1)
})

test('the desktop app opens the pane when it attaches, not again on a reconnect', async ($, on) => {
  const { panes, opens } = setup(on, {})
  await $.session.start({ source: 'startup', cwd: 'C:/work/p1', surface: null } as never)
  await $.session.attach(attach('mobile'))
  expect(opens).toHaveLength(0)

  await $.session.attach(attach('desktop'))
  expect(opens).toEqual([{ id: 'sessions', focus: undefined }])
  panes.length = 0
  await $.session.attach(attach('desktop'))
  expect(opens).toHaveLength(1)
})

test('a cloud session never opens the pane unasked', async ($, on) => {
  const { opens } = setup(on, {}, { CLAUDE_CODE_REMOTE: 'true' })
  await $.session.start({ source: 'startup', cwd: '/w', surface: 'terminal' } as never)
  await $.session.attach(attach('desktop'))
  expect(opens).toHaveLength(0)
})

const CLOUD_ENV = { CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_A' }

const cloudSession = (id: string, fields: Record<string, unknown>) => ({
  id: `session_${id}`,
  title: `Task ${id}`,
  status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED',
  updated_at: new Date(NOW).toISOString(),
  ...fields,
})

// list_sessions answers with its JSON inside an untrusted-data envelope.
const listing = (sessions: unknown[]) =>
  `<other-session nonce="n" untrusted="true">\nA session's record (JSON):\n${JSON.stringify({ ccr: { data: sessions } })}\n</other-session nonce="n">`

const cloudSetup = (on: On, sessions: unknown[]) => {
  const base = setup(on, {}, CLOUD_ENV)
  const calls: unknown[] = []
  on('mcp.call', ($, e) => {
    calls.push(e)
    return { value: { content: [{ type: 'text', text: listing(sessions) }], isError: false } } as never
  })
  return { ...base, calls }
}

test('parse reads a cloud session list, envelope and all', () => {
  const blocked = { status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', external_metadata: { post_turn_summary: { needs_action: 'Approve the push' } } }
  expect(parseCloudSessions(listing([
    cloudSession('A', { status_bucket: 'SESSION_STATUS_BUCKET_WORKING' }),
    cloudSession('B', blocked),
    cloudSession('C', { post_turn_summary: { status_category: 'completed' }, external_metadata: { post_turn_summary: { needs_action: '' } } }),
    { title: 'no id' },
  ]))).toEqual([
    { id: 'session_A', cwd: '', name: 'Task A', status: 'busy', updatedAt: NOW, url: 'https://claude.ai/code/session_A', needs: undefined },
    { id: 'session_B', cwd: '', name: 'Task B', status: 'blocked', updatedAt: NOW, url: 'https://claude.ai/code/session_B', needs: 'Approve the push' },
    { id: 'session_C', cwd: '', name: 'Task C', status: 'idle', updatedAt: NOW, url: 'https://claude.ai/code/session_C', needs: undefined },
  ])
  expect(parseCloudSessions('no json here')).toBeUndefined()
  expect(parseCloudSessions('{"ccr":{}}')).toBeUndefined()
  expect(cloudSessionId('cse_A')).toBe('session_A')
})

test('a cloud session lists recent cloud sessions with an Open link and what each needs', async ($, on) => {
  const { calls, lists } = cloudSetup(on, [
    cloudSession('A', { status_bucket: 'SESSION_STATUS_BUCKET_WORKING' }),
    cloudSession('B', { status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', external_metadata: { post_turn_summary: { needs_action: 'Approve the push' } } }),
    cloudSession('C', { updated_at: new Date(NOW - 3 * 3_600_000).toISOString() }),
  ])
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(calls).toEqual([{ server: 'claude-code-remote', tool: 'list_sessions', args: { mine: true, limit: 10 } }])
  expect(lists()).toBe(0)

  for (const surface of [...SURFACES, 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'sessions', surface, ...PANE })
    expect(await ui.findAll({ type: 'Text', text: /^3 recent$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^\s*needs input$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^\s*Approve the push$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^· 3h$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^· this session$/ })).toHaveLength(1)
    const links = (await ui.findAll({ type: 'Link' })).map(link => link.props.href)
    expect(links).toEqual(['https://claude.ai/code/session_B', 'https://claude.ai/code/session_C'])
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(keys).toEqual(['refresh'])
    await ui.unmount()
  }
})

test('a cloud pane refreshes every 30 seconds, not every 5', async ($, on) => {
  const { clock, calls } = cloudSetup(on, [cloudSession('A', {})])
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(calls).toHaveLength(1)
  await clock.advance(25_000)
  expect(calls).toHaveLength(1)
  await clock.advance(5_000)
  expect(calls).toHaveLength(2)
})

test('a cloud session without the remote server says so', async ($, on) => {
  setup(on, {}, CLOUD_ENV)
  on('mcp.call', () => {
    throw new Error('no such server')
  })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /Couldn't reach the claude-code-remote MCP server/ })).toHaveLength(1)
  await ui.unmount()
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
