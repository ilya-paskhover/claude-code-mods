import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const setup = (on: On) => {
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const usage: { limits: SessionRateLimit[] } = { limits: [] }
  on('session.cwd', () => ({ value: 'D:\\proj' }) as never)
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
  return { clock, toasts, statuses, usage }
}

test('band shows time, edits inside the folder and failed tools', async ($, on) => {
  const { clock, toasts, statuses } = setup(on)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'd:/PROJ/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  await clock.advance(42_000)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toHaveLength(0)
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
  const { clock, toasts } = setup(on)

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\me\\.claude\\settings.json', content: '{}' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'src/ok.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.advance(5_000)
  await $.turn.complete({ reason: 'answer' } as never)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('settings.json')
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
  expect(statuses.at(-1)).toBe('session: 5h +4% · week +1.5%')

  // The 5h window resets mid-session: what it used before is carried over.
  await $.prompt.submit({ text: 'two' } as never)
  usage.limits = [
    { kind: 'five_hour', percentUsed: 2, resetsAt: 'B' },
    { kind: 'seven_day', percentUsed: 22, resetsAt: 'W' },
  ]
  await $.turn.complete({ reason: 'answer' } as never)
  expect(statuses.at(-1)).toBe('session: 5h +6% · week +2%')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'turn-pulse', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.findAll({ type: 'Text', text: /^5h \+2% · week \+0\.5%$/ })).toHaveLength(1)
    await ui.unmount()
  }
})
