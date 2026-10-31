import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const setup = (on: On, env: Record<string, string> = {}) => {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const usage: { limits: SessionRateLimit[] } = { limits: [] }
  on('session.cwd', () => ({ value: 'D:\\proj' }) as never)
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.measure', () => ({ changed: [] }) as never)
  const commands: { name: string; argumentHint?: string }[] = []
  on('command.register', ($, e) => {
    commands.push(e as { name: string; argumentHint?: string })
    return { value: { command: 'pulse' } } as never
  })
  on('session.usage', () =>
    ({ value: { startedAt: 0, context: {}, rateLimits: usage.limits } }) as never,
  )
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.status', ($, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('tool.call', ($, e) =>
    (e.tool === 'Bash' ? { result: 'boom', isError: true } : { result: 'ok' }) as never,
  )
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined } as never
  })
  return { clock, toasts, statuses, usage, store, commands }
}

const BAND_ON = { command: 'pulse', args: 'band on' } as never
const BAND = { plugin: 'turn-pulse', component: 'AbovePrompt', props: {} as never } as const

test('band shows time, edits inside the folder and failed tools', async ($, on) => {
  const { clock, toasts, statuses } = setup(on)
  await $.command.run(BAND_ON)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'd:/PROJ/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  await clock.advance(42_000)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toEqual([])
  expect(statuses).toContain('▶ Bash · 1 ok · ✗ 1 failed')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'turn-pulse', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.findAll({ type: 'Text', text: /42s/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /✎ app\.ts/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /1 failed \(Bash\)/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /outside/ })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Text', text: /^✓ 1 ok$/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('edits outside the folder are flagged and toasted', async ($, on) => {
  const { clock, toasts, statuses } = setup(on)
  await $.command.run(BAND_ON)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\me\\.claude\\settings.json', content: '{}' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'src/ok.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.advance(5_000)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('settings.json')
  expect(statuses.at(-1)).toBe('last turn 5s · ⚠ outside: settings.json · ok.ts · 2 ok')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'turn-pulse', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.findAll({ type: 'Text', text: /⚠ outside: settings\.json/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /✎ ok\.ts/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('a long turn ends with a toast', async ($, on) => {
  const { clock, toasts } = setup(on)

  await $.prompt.submit({ text: 'hi' } as never)
  await clock.advance(134_000)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toEqual(['Done in 2m 14s · 0 files edited'])
})

test('limits: the turn cost goes in the band, the session total in the status line', async ($, on) => {
  const { statuses, usage } = setup(on)
  await $.command.run(BAND_ON)
  usage.limits = [
    { kind: 'five_hour', percentUsed: 30, resetsAt: 'A' },
    { kind: 'seven_day', percentUsed: 20, resetsAt: 'W' },
  ]

  await $.prompt.submit({ text: 'one' } as never)
  usage.limits = [
    { kind: 'five_hour', percentUsed: 34, resetsAt: 'A' },
    { kind: 'seven_day', percentUsed: 21.5, resetsAt: 'W' },
  ]
  await $.turn.complete({ reason: 'answer' } as never)
  expect(statuses.at(-1)).toBe('last turn 0s · no edits · 0 ok · session: 5h +4% · week +1.5%')

  // The 5h window resets mid-session: what it used before is carried over.
  await $.prompt.submit({ text: 'two' } as never)
  usage.limits = [
    { kind: 'five_hour', percentUsed: 2, resetsAt: 'B' },
    { kind: 'seven_day', percentUsed: 22, resetsAt: 'W' },
  ]
  await $.turn.complete({ reason: 'answer' } as never)
  expect(statuses.at(-1)).toBe('last turn 0s · no edits · 0 ok · session: 5h +6% · week +2%')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'turn-pulse', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.findAll({ type: 'Text', text: /^5h \+2% · week \+0\.5%$/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('/pulse in a cloud session prints the last turn and the session total', async ($, on) => {
  const { clock, usage } = setup(on, { CLAUDE_CODE_REMOTE: 'true' })

  expect((await $.command.run({ command: 'pulse', args: '' } as never)).text).toBe('No turn has finished yet.')

  usage.limits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: 'A' }]
  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'd:/proj/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  await clock.advance(42_000)
  usage.limits = [{ kind: 'five_hour', percentUsed: 11, resetsAt: 'A' }]
  await $.turn.complete({ reason: 'answer' } as never)

  expect((await $.command.run({ command: 'pulse', args: '' } as never)).text).toBe(
    '◆ last turn · ⏱ 42s · ✎ app.ts · ✓ 1 ok · ✗ 1 failed (Bash) · 5h +1%\nsession: 5h +1%',
  )
})

test('/pulse in a cloud session: outside paths, a capped file list, no edits and repeated failures', async ($, on) => {
  const { clock } = setup(on, { CLAUDE_CODE_REMOTE: 'true' })

  await $.prompt.submit({ text: 'one' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\me\\.claude\\settings.json', content: '{}' } as never)
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await $.tool.call({ tool: 'Edit', file_path: `d:/proj/src/${name}.ts`, old_string: 'a', new_string: 'b' } as never)
  }
  await clock.advance(7_000)
  await $.turn.complete({ reason: 'answer' } as never)
  expect((await $.command.run({ command: 'pulse', args: '' } as never)).text).toBe(
    '◆ last turn · ⏱ 7s · ⚠ outside: C:\\Users\\me\\.claude\\settings.json · ✎ a.ts, b.ts, c.ts +2 · ✓ 6 ok',
  )

  await $.prompt.submit({ text: 'two' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  await clock.advance(3_000)
  await $.turn.complete({ reason: 'answer' } as never)
  expect((await $.command.run({ command: 'pulse', args: '' } as never)).text).toBe(
    '◆ last turn · ⏱ 3s · no edits · ✓ 0 ok · ✗ 2 failed (Bash ×2)',
  )
})

test('/pulse in a cloud session measures the session total afresh', async ($, on) => {
  const { usage } = setup(on, { CLAUDE_CODE_REMOTE: 'true' })
  usage.limits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: 'A' }]

  await $.prompt.submit({ text: 'hi' } as never)
  await $.turn.complete({ reason: 'answer' } as never)
  // The window moves less than a point after the turn: no measure event fires.
  usage.limits = [{ kind: 'five_hour', percentUsed: 10.9, resetsAt: 'A' }]

  expect((await $.command.run({ command: 'pulse', args: '' } as never)).text).toContain('session: 5h +0.9%')
})

test('the band is off by default and leaves the slot to the mods beneath', async ($, on) => {
  const { clock } = setup(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })

  await $.prompt.submit({ text: 'hi' } as never)
  await clock.advance(3_000)
  await $.turn.complete({ reason: 'answer' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Text', text: /last turn/ })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Text', text: 'other band' })).toHaveLength(1)
    await ui.unmount()
  }
})

test('band on: a row from next(e) still draws, below ours', async ($, on) => {
  const { clock } = setup(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })

  await $.prompt.submit({ text: 'hi' } as never)
  await clock.advance(3_000)
  await $.turn.complete({ reason: 'answer' } as never)
  await $.command.run(BAND_ON)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts[0]).toBe('◆ last turn')
    expect(texts.at(-1)).toBe('other band')
    await ui.unmount()
  }
})

test('/pulse band sets, switches and saves the state; a bad argument changes nothing', async ($, on) => {
  const { store } = setup(on)
  const pulse = async (args: string) => (await $.command.run({ command: 'pulse', args } as never)).text

  expect(await pulse('')).toBe('Turn pulse band is off. Change it with /pulse band [on|off].')
  expect(await pulse('band on')).toBe('Turn pulse band on.')
  expect(store.get('isBandOn')).toBe(true)
  expect(await pulse('')).toBe('Turn pulse band is on. Change it with /pulse band [on|off].')
  expect(await pulse('band')).toBe('Turn pulse band off.')
  expect(store.get('isBandOn')).toBe(false)
  expect(await pulse('band')).toBe('Turn pulse band on.')
  expect(await pulse('band off')).toBe('Turn pulse band off.')
  expect(await pulse('band maybe')).toBe('Usage: /pulse band [on|off]')
  expect(await pulse('nonsense')).toBe('Usage: /pulse band [on|off]')
  expect(store.get('isBandOn')).toBe(false)
})

test('/pulse registers with the band argument in its hint', async ($, on) => {
  const { commands } = setup(on)

  await $.session.start({ source: 'startup', cwd: 'D:\\proj' } as never)

  expect(commands.map(({ name, argumentHint }) => [name, argumentHint])).toEqual([['pulse', 'band [on|off]']])
})

test('a saved choice turns the band on in a new session', async ($, on) => {
  const { store } = setup(on)
  store.set('isBandOn', true)
  await $.session.start({ source: 'startup', cwd: 'D:\\proj' } as never)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.turn.complete({ reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /last turn/ })).toHaveLength(1)
  await ui.unmount()
})

test('an older or unknown stored value means off', async ($, on) => {
  const { store } = setup(on)
  store.set('isBandOn', 'yes')
  store.set('isHidden', false)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  await $.session.start({ source: 'startup', cwd: 'D:\\proj' } as never)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.turn.complete({ reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /last turn/ })).toHaveLength(0)
  await ui.unmount()
})

test('Hide switches the saved setting off', async ($, on) => {
  const { store } = setup(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })

  await $.prompt.submit({ text: 'hi' } as never)
  await $.turn.complete({ reason: 'answer' } as never)
  await $.command.run(BAND_ON)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide' } as never)
  expect(store.get('isBandOn')).toBe(false)
  expect(await ui.findAll({ type: 'Text', text: /last turn/ })).toHaveLength(0)
  await ui.unmount()
})

test('the status line reports the last turn whether the band is on or off, the live line during a turn', async ($, on) => {
  const { clock, statuses, usage } = setup(on)
  usage.limits = [
    { kind: 'five_hour', percentUsed: 10, resetsAt: 'A' },
    { kind: 'seven_day', percentUsed: 5, resetsAt: 'W' },
  ]

  await $.prompt.submit({ text: 'hi' } as never)
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await $.tool.call({ tool: 'Edit', file_path: `d:/proj/src/${name}.ts`, old_string: 'a', new_string: 'b' } as never)
  }
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  expect(statuses.at(-1)).toBe('▶ Bash · 5 ok · ✗ 1 failed')
  await clock.advance(35_000)
  usage.limits = [
    { kind: 'five_hour', percentUsed: 12, resetsAt: 'A' },
    { kind: 'seven_day', percentUsed: 5, resetsAt: 'W' },
  ]
  await $.turn.complete({ reason: 'answer' } as never)
  const line = 'last turn 35s · a.ts, b.ts, c.ts +2 · 5 ok · 1 failed (Bash) · session: 5h +2% · week +0%'
  expect(statuses.at(-1)).toBe(line)

  // The band's setting does not touch the line.
  await $.command.run(BAND_ON)
  await $.session.measure({ rateLimits: usage.limits } as never)
  expect(statuses.at(-1)).toBe(line)
})

test('session.measure between turns refreshes the spend; mid-turn it leaves the live line alone', async ($, on) => {
  const { statuses, usage } = setup(on)
  usage.limits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: 'A' }]

  await $.prompt.submit({ text: 'one' } as never)
  await $.turn.complete({ reason: 'answer' } as never)
  await $.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: 'A' }] } as never)
  expect(statuses.at(-1)).toBe('last turn 0s · no edits · 0 ok · session: 5h +2%')

  await $.prompt.submit({ text: 'two' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'x' } as never)
  await $.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 13, resetsAt: 'A' }] } as never)
  expect(statuses.at(-1)).toBe('▶ Read · 1 ok')
})

test('session.start shows a saved pulse, and nothing without one', async ($, on) => {
  const { statuses } = setup(on)
  const start = { source: 'startup', cwd: 'D:\\proj' } as never

  await $.session.start(start)
  expect(statuses).toEqual([])

  await $.prompt.submit({ text: 'hi' } as never)
  await $.turn.complete({ reason: 'answer' } as never)
  statuses.length = 0
  await $.session.start(start)
  expect(statuses).toEqual(['last turn 0s · no edits · 0 ok'])
})

test('a notebook edit outside the folder is flagged', async ($, on) => {
  const { toasts } = setup(on)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:\\other\\nb.ipynb', new_source: 'x' } as never)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('nb.ipynb')
})

test('a folder that only shares a name prefix is outside', async ($, on) => {
  const { toasts } = setup(on)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'D:\\proj-old\\x.ts', content: '' } as never)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('proj-old')
})

test('a turn that ends without a start, as after a reload, leaves no bogus time', async ($, on) => {
  const { clock, toasts } = setup(on)
  await clock.advance(Date.UTC(2026, 9, 9))

  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toEqual([])
})

test('limits: a window that drops without a new reset time still carries what it used', async ($, on) => {
  const { statuses, usage } = setup(on)
  usage.limits = [{ kind: 'five_hour', percentUsed: 30 }]

  await $.prompt.submit({ text: 'one' } as never)
  usage.limits = [{ kind: 'five_hour', percentUsed: 34 }]
  await $.turn.complete({ reason: 'answer' } as never)

  await $.prompt.submit({ text: 'two' } as never)
  usage.limits = [{ kind: 'five_hour', percentUsed: 2 }]
  await $.turn.complete({ reason: 'answer' } as never)
  expect(statuses.at(-1)).toBe('last turn 0s · no edits · 0 ok · session: 5h +6%')
})
