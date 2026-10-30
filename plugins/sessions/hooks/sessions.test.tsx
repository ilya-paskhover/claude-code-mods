import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  STALE_MS,
  transcriptModel,
} from './parse'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = { component: 'Pane', requestId: 'sessions', props: {} as never } as const
// The engine hands fs hooks the path with the platform's separators. Off Windows,
// C:/ is not absolute, so the engine prefixes the mod folder; drop that prefix.
const DIR = 'C:/Users/dev/.claude/sessions'
const slashed = (e: unknown) => {
  const path = (e as { path: string }).path.replace(/\\/g, '/')
  // On Windows the macOS test's rooted path gets the current drive, so drop that too.
  const at = path.search(/C:\/|\/Users\/dev\/Library\//)
  return at < 0 ? path : path.slice(at)
}
const NOW = Date.UTC(2026, 9, 9, 12, 0)

const file = (pid: number, fields: Record<string, unknown>) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: `C:\\work\\p${pid}`, status: 'idle', updatedAt: NOW, ...fields })

// tree: other files by full path; listing a folder gives its files and subfolders.
// A tree file starting with BIG is over $.fs.read's limit: only its tail can be read.
// table: the process table's output, read when asked; THROW makes the read fail.
const BIG = 'BIG\n'
const setup = (
  on: On,
  files: Record<string, string>,
  env: Record<string, string> = {},
  table: string | (() => string) = '',
  tree: Record<string, string> = {},
) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\dev', ...env })
  const panes: { id: string }[] = []
  const opens: { id: string; focus?: boolean }[] = []
  let lists = 0
  on('fs.list', ($, e) => {
    if (slashed(e) !== DIR) {
      const under = Object.keys(tree).filter(path => path.startsWith(`${slashed(e)}/`))
      if (under.length === 0) throw new Error('ENOENT')
      const names = [...new Set(under.map(path => path.slice(slashed(e).length + 1).split('/')[0]!))]
      return {
        value: names.map(name => {
          const text = tree[`${slashed(e)}/${name}`]
          const size = text === undefined ? 1 : text.startsWith(BIG) ? 5 * 1024 * 1024 : text.length
          return { name, kind: text === undefined ? 'dir' : 'file', size, mtimeMs: 0, isLink: false }
        }),
      } as never
    }
    lists++
    return { value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  const reads: string[] = []
  on('fs.read', ($, e) => {
    reads.push(slashed(e))
    if (tree[slashed(e)]?.startsWith(BIG)) throw new Error('over 4 MiB')
    if (slashed(e) in tree) return { value: tree[slashed(e)] } as never
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
  let tableReads = 0
  const tableCommands: string[] = []
  on('process.run', ($, e) => {
    const { argv } = e as { argv: string[] }
    if (argv[0] === 'ps' || argv.some(arg => arg.includes('Win32_Process'))) {
      tableReads++
      tableCommands.push(argv[0]!)
      const out = typeof table === 'function' ? table() : table
      if (out === 'THROW') throw new Error('not found')
      return { value: { exitCode: 0, stdout: out, stderr: '' } } as never
    }
    if (argv[0] === 'tail' || argv.some(arg => arg.startsWith('Get-Content'))) {
      const path = argv[0] === 'tail' ? argv.at(-1)! : /'(.*)'/.exec(argv.at(-1)!)![1]!
      return { value: { exitCode: 0, stdout: (tree[path.replace(/\\/g, '/')] ?? '').slice(BIG.length), stderr: '' } } as never
    }
    runs.push([...argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return { clock, panes, opens, runs, reads, tableCommands, lists: () => lists, tableReads: () => tableReads }
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

test('the process table links a session to its nearest session ancestor', () => {
  const table = parseProcessTable('  10  1\r\n50 10\n60 50\n70 80\n80 70\nnoise\n')
  const sessions = new Set([10, 60])
  expect(sessionAncestor(60, table, sessions)).toBe(10)
  expect(sessionAncestor(10, table, sessions)).toBeUndefined()
  expect(sessionAncestor(70, table, sessions)).toBeUndefined()
  expect(sessionAncestor(99, table, sessions)).toBeUndefined()
})

test('nesting puts children under their parent and never loses a row', () => {
  const row = (pid: number, parent?: number) => ({ ...parseSession(file(pid, {}))!, parent: parent === undefined ? undefined : `s-${parent}` })
  const shape = (rows: ReturnType<typeof row>[]) => nestRows(rows).map(n => [n.row.pid, n.depth])
  expect(shape([row(3, 2), row(1), row(2, 1), row(4)])).toEqual([[1, 0], [2, 1], [3, 2], [4, 0]])
  expect(shape([row(1, 99)])).toEqual([[1, 0]])
  expect(shape([row(1, 2), row(2, 1)])).toEqual([[1, 0], [2, 1]])
})

test('the pane draws a spawned session under its parent and reads the table only for new sessions', async ($, on) => {
  const files: Record<string, string> = {
    '1.json': file(1, { name: 'Parent', updatedAt: NOW - 60_000 }),
    '5.json': file(5, { name: 'Child', status: 'busy' }),
    '3.json': file(3, { name: 'Other' }),
  }
  const { clock, tableReads } = setup(on, files, {}, '1 900\n50 1\n5 50\n3 900\n')
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(tableReads()).toBe(1)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sessions', surface, ...PANE })
    const names = await ui.findAll({ type: 'Text', text: /^(Parent|Child|Other)$/ })
    expect(names.map(n => (n as { text: string }).text)).toEqual(['Other', 'Parent', 'Child'])
    expect(await ui.findAll({ type: 'Text', text: /^└$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^3 running$/ })).toHaveLength(1)
    await ui.unmount()
  }

  await clock.advance(5_000)
  expect(tableReads()).toBe(1)
  files['6.json'] = file(6, { name: 'New' })
  await clock.advance(5_000)
  expect(tableReads()).toBe(2)
})

test('a lone session reads no process table, and an empty table leaves the list flat', async ($, on) => {
  const files: Record<string, string> = { '1.json': file(1, { name: 'Alone' }) }
  const { clock, tableReads } = setup(on, files)
  await $.session.start({ source: 'startup', cwd: 'C:/work/p1' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(tableReads()).toBe(0)

  files['5.json'] = file(5, { name: 'Other' })
  await clock.advance(5_000)
  expect(tableReads()).toBe(1)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /^(Alone|Other)$/ })).toHaveLength(2)
  expect(await ui.findAll({ type: 'Text', text: /^└$/ })).toHaveLength(0)
  await ui.unmount()
})

test('parse reads what the desktop file and the transcript say about a session', () => {
  expect(parseDesktopSession(JSON.stringify({ model: 'm', spawnedFrom: { sessionId: 'local_1' } }))).toEqual({ model: 'm', parentHost: 'local_1' })
  expect(parseDesktopSession(JSON.stringify({ spawnedFrom: null }))).toEqual({ model: undefined, parentHost: undefined })
  expect(parseDesktopSession('{broken')).toBeUndefined()
  expect(projectFolder('C:\\work\\my.app')).toBe('C--work-my-app')

  const reply = (model: string, fields: Record<string, unknown> = {}) =>
    JSON.stringify({ message: { role: 'assistant', model }, ...fields })
  expect(transcriptModel([reply('old'), reply('new'), reply('<synthetic>'), reply('sub', { isSidechain: true }), '{"assistant', ''].join('\n'))).toBe('new')
  expect(transcriptModel(JSON.stringify({ type: 'user', toolUseResult: { role: 'assistant', model: 'quoted' } }))).toBeUndefined()
  expect(transcriptModel('')).toBeUndefined()
})

test('the desktop file nests a started session under its parent and names models', async ($, on) => {
  const FOLDER = 'C:/AppData/Claude/claude-code-sessions/org/user'
  const reply = JSON.stringify({ message: { role: 'assistant', model: 'claude-haiku-5-5' } })
  const { clock } = setup(
    on,
    {
      '1.json': file(1, { name: 'Parent', hostSessionId: 'local_1', updatedAt: NOW - 60_000 }),
      '2.json': file(2, { name: 'Started', hostSessionId: 'local_2' }),
      '5.json': file(5, { name: 'Headless' }),
      '6.json': file(6, { name: 'No transcript yet' }),
    },
    { APPDATA: 'C:\\AppData' },
    '1 900\n2 900\n5 1\n6 900\n',
    {
      [`${FOLDER}/local_1.json`]: JSON.stringify({ model: 'claude-opus-5-5' }),
      [`${FOLDER}/local_2.json`]: JSON.stringify({ model: 'claude-sonnet-5-5', spawnedFrom: { sessionId: 'local_1' } }),
      'C:/Users/dev/.claude/projects/C--work-p5/s-5.jsonl': reply,
    },
  )
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)

  const check = async () => {
    const ui = await $.ui.mount({ plugin: 'sessions', surface: 'desktop', ...PANE })
    const names = await ui.findAll({ type: 'Text', text: /^(Parent|Started|Headless|No transcript yet)$/ })
    expect(names.map(n => (n as { text: string }).text)).toEqual(['No transcript yet', 'Parent', 'Started', 'Headless'])
    expect(await ui.findAll({ type: 'Text', text: /^└$/ })).toHaveLength(2)
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(await ui.findAll({ type: 'Text', text: `· ${model}` })).toHaveLength(1)
    }
    await ui.unmount()
  }
  await check()
  await clock.advance(5_000)
  await check()
})

const marks = async ($: { ui: { mount: (o: never) => Promise<{ findAll: (q: never) => Promise<unknown[]>; unmount: () => Promise<void> }> } }) => {
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE } as never)
  const found = (await ui.findAll({ type: 'Text', text: /^└$/ } as never)).length
  await ui.unmount()
  return found
}

test('a failed table read leaves the list flat, then is tried again soon, backing off', async ($, on) => {
  const files: Record<string, string> = { '1.json': file(1, { name: 'Parent' }), '5.json': file(5, { name: 'Child' }) }
  let table = 'THROW'
  const { clock, tableReads } = setup(on, files, {}, () => table)
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(tableReads()).toBe(1)
  expect(await marks($)).toBe(0)

  // After 5 s, then 10 s, then 20 s.
  await clock.advance(5_000)
  expect(tableReads()).toBe(2)
  await clock.advance(5_000)
  expect(tableReads()).toBe(2)
  await clock.advance(5_000)
  expect(tableReads()).toBe(3)
  expect(await marks($)).toBe(0)

  table = '1 900\n5 1\n'
  await clock.advance(15_000)
  expect(tableReads()).toBe(3)
  await clock.advance(5_000)
  expect(tableReads()).toBe(4)
  expect(await marks($)).toBe(1)

  await clock.advance(60_000)
  expect(tableReads()).toBe(4)
})

test('a table that keeps failing is read at most once a minute', async ($, on) => {
  const files: Record<string, string> = { '1.json': file(1, { name: 'Parent' }), '5.json': file(5, { name: 'Child' }) }
  const { clock, tableReads } = setup(on, files, {}, () => 'THROW')
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  await clock.advance(5_000 + 10_000 + 20_000 + 40_000 + 60_000)
  expect(tableReads()).toBe(6)
  await clock.advance(55_000)
  expect(tableReads()).toBe(6)
  await clock.advance(5_000)
  expect(tableReads()).toBe(7)
})

test('a parent file caught mid-write does not unlink its child for good', async ($, on) => {
  const files: Record<string, string> = { '1.json': '{half written', '5.json': file(5, { name: 'Child' }), '3.json': file(3, { name: 'Other' }) }
  const { clock } = setup(on, files, {}, '1 900\n5 1\n3 900\n')
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(await marks($)).toBe(0)
  // Readable again, the parent shows up as a new session, which looks again.
  files['1.json'] = file(1, { name: 'Parent' })
  await clock.advance(5_000)
  expect(await marks($)).toBe(1)
})

test('a child whose parent exited stays top-level when a new session takes the parent pid', async ($, on) => {
  const files: Record<string, string> = { '1.json': file(1, { name: 'Parent' }), '5.json': file(5, { name: 'Child' }), '3.json': file(3, { name: 'Other' }) }
  let table = '1 900\n5 1\n3 900\n'
  const { clock } = setup(on, files, {}, () => table)
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(await marks($)).toBe(1)

  delete files['1.json']
  await clock.advance(5_000)
  files['1.json'] = JSON.stringify({ pid: 1, sessionId: 's-new', cwd: 'C:\\work\\q', status: 'idle', updatedAt: NOW, name: 'Q' })
  table = '1 901\n5 900\n3 900\n'
  await clock.advance(5_000)
  expect(await marks($)).toBe(0)
})

test('on Windows the table comes from PowerShell', async ($, on) => {
  const files: Record<string, string> = { '1.json': file(1, { name: 'Parent' }), '5.json': file(5, { name: 'Child' }) }
  const { tableCommands } = setup(on, files, { OS: 'Windows_NT' }, '1 900\r\n5 1\r\n')
  await $.session.start({ source: 'startup', cwd: 'C:/work/p2' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  expect(tableCommands).toEqual(['powershell'])
  expect(await marks($)).toBe(1)
})

test('on macOS the desktop files come from Application Support, and a gone desktop parent falls back to the table', async ($, on) => {
  const FOLDER = '/Users/dev/Library/Application Support/Claude/claude-code-sessions/org/user'
  setup(
    on,
    { '1.json': file(1, { name: 'Parent' }), '2.json': file(2, { name: 'Started', hostSessionId: 'local_2' }) },
    { HOME: '/Users/dev', USERPROFILE: 'C:\\Users\\dev' },
    '1 900\n2 1\n',
    { [`${FOLDER}/local_2.json`]: JSON.stringify({ model: 'claude-sonnet-5-5', spawnedFrom: { sessionId: 'local_gone' } }) },
  )
  await $.session.start({ source: 'startup', cwd: 'C:/work/p3' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: '· claude-sonnet-5-5' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /^└$/ })).toHaveLength(1)
  await ui.unmount()
})

test('a transcript is read until it names a model, and a long one from its end', async ($, on) => {
  const PROJECTS = 'C:/Users/dev/.claude/projects'
  const reply = (model: string) => JSON.stringify({ message: { role: 'assistant', model } })
  const { clock, reads } = setup(on, { '1.json': file(1, { name: 'Short' }), '2.json': file(2, { name: 'Long' }) }, {}, '1 900\n2 900\n', {
    [`${PROJECTS}/C--work-p1/s-1.jsonl`]: reply('claude-haiku-5-5'),
    [`${PROJECTS}/C--work-p2/s-2.jsonl`]: `${BIG}${reply('claude-opus-5-5')}\n`,
  })
  await $.session.start({ source: 'startup', cwd: 'C:/work/p3' } as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  await clock.advance(5_000)
  expect(reads.filter(path => path.endsWith('s-1.jsonl'))).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', ...PANE })
  for (const model of ['claude-haiku-5-5', 'claude-opus-5-5']) {
    expect(await ui.findAll({ type: 'Text', text: `· ${model}` })).toHaveLength(1)
  }
  await ui.unmount()
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
