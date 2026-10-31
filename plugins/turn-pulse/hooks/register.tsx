import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { EditedFile, Pulse, WindowTrack } from '../types'

const last = atom({ plugin: 'turn-pulse', key: 'last' } as const, null)
const isBandOn = atom({ plugin: 'turn-pulse', key: 'isBandOn' } as const, false)
const windows = atom({ plugin: 'turn-pulse', key: 'windows' } as const, {})

const EDITING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SLOW_SECONDS = 120
const TOAST_SECONDS = 60
const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week' }

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

// Windows paths compare case-insensitively and with either slash.
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const isAbsolute = (path: string) => /^([a-z]:)?[\\/]/i.test(path)
const isOutsideOf = (cwd: string, path: string) => {
  if (!isAbsolute(path) || cwd === '') return false
  const root = normalize(cwd)
  const target = normalize(path)
  return target !== root && !target.startsWith(`${root}/`)
}

const formatTime = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`

const round = (n: number) => Math.round(n * 10) / 10
const label = (kind: string) => WINDOW_LABELS[kind] ?? kind
const formatSpent = (spent: Record<string, number>) =>
  Object.entries(spent)
    .map(([kind, n]) => `${label(kind)} +${round(n)}%`)
    .join(' · ')

// The limits are account-wide: the session's share is how far each window
// moved since the session first saw it, carried across window resets.
const track = (tracks: Record<string, WindowTrack>, limits: SessionRateLimit[]) => {
  const next = { ...tracks }
  for (const limit of limits) {
    const now = limit.percentUsed
    const seen = next[limit.kind]
    if (seen === undefined) {
      next[limit.kind] = { start: now, last: now, carried: 0, resetsAt: limit.resetsAt }
      continue
    }
    const hasReset =
      (limit.resetsAt !== undefined && seen.resetsAt !== undefined && limit.resetsAt !== seen.resetsAt) ||
      now < seen.last - 0.5
    next[limit.kind] = hasReset
      ? { start: 0, last: now, carried: seen.carried + (seen.last - seen.start), resetsAt: limit.resetsAt }
      : { ...seen, last: now, resetsAt: limit.resetsAt ?? seen.resetsAt }
  }
  return next
}

const sessionSpent = (tracks: Record<string, WindowTrack>) =>
  Object.fromEntries(
    Object.entries(tracks).map(([kind, t]) => [kind, Math.max(0, t.carried + t.last - t.start)]),
  )

const countFails = (failed: Record<string, number>) => Object.values(failed).reduce((a, b) => a + b, 0)

function liveStatus($: EngineInterface, tool: string, ok: number, fails: number) {
  $.ui.status(`▶ ${tool} · ${ok} ok${fails > 0 ? ` · ✗ ${fails} failed` : ''}`)
}

// Reads the windows, folds them into the session's tracks, returns its spend.
async function measure($: EngineInterface, limits?: SessionRateLimit[]) {
  const reading = limits ?? (await $.session.usage()).rateLimits
  const tracks = await update($, windows, tracks => track(tracks, reading))
  return sessionSpent(tracks)
}

const isCloud = async ($: EngineInterface) => (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'

// The state redraws the band; the store carries the choice to other sessions.
async function setBand($: EngineInterface, isOn: boolean) {
  await update($, isBandOn, () => isOn)
  await $.store.set('isBandOn', isOn)
}

// A pulse saved by an older version of this mod has another shape: skip it.
const isCurrent = (pulse: Pulse | null): pulse is Pulse => pulse !== null && typeof pulse.ok === 'number'

// The parts of a pulse the band, the status line and /pulse all show.
function describe(pulse: Pulse) {
  const outside = pulse.files.filter(file => file.isOutside)
  const inside = pulse.files.filter(file => !file.isOutside)
  return {
    outside,
    inside,
    shown: inside.slice(0, 3).map(file => file.name).join(', '),
    more: inside.length > 3 ? ` +${inside.length - 3}` : '',
    fails: countFails(pulse.failed),
    failures: Object.entries(pulse.failed)
      .map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool))
      .join(', '),
    spent: pulse.spent ?? {},
  }
}

// The band as one line of text, for /pulse in cloud sessions. Edits outside
// the folder show full paths, as in the toast, since text has the room.
function summarize(pulse: Pulse) {
  const { outside, inside, shown, more, fails, failures, spent } = describe(pulse)
  const parts = ['◆ last turn', `⏱ ${formatTime(pulse.seconds)}`]
  if (outside.length > 0) parts.push(`⚠ outside: ${outside.map(file => file.path).join(', ')}`)
  if (inside.length > 0) parts.push(`✎ ${shown}${more}`)
  if (pulse.files.length === 0) parts.push('no edits')
  parts.push(`✓ ${pulse.ok} ok`)
  if (fails > 0) parts.push(`✗ ${fails} failed (${failures})`)
  if (Object.keys(spent).length > 0) parts.push(formatSpent(spent))
  return parts.join(' · ')
}

// The status line between turns: the last turn, then the session's spend.
function idleStatus($: EngineInterface, pulse: Pulse | null, spent: Record<string, number>) {
  const parts: string[] = []
  if (isCurrent(pulse)) {
    const { outside, inside, shown, more, fails, failures } = describe(pulse)
    parts.push(`last turn ${formatTime(pulse.seconds)}`)
    if (outside.length > 0) parts.push(`⚠ outside: ${outside.map(file => file.name).join(', ')}`)
    if (inside.length > 0) parts.push(`${shown}${more}`)
    if (pulse.files.length === 0) parts.push('no edits')
    parts.push(`${pulse.ok} ok`)
    if (fails > 0) parts.push(`${fails} failed (${failures})`)
  }
  if (Object.keys(spent).length > 0) parts.push(`session: ${formatSpent(spent)}`)
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
}

export const register: Register = on => {
  let cwd = ''
  let startedAt = 0
  let inTurn = false
  let ok = 0
  let files = new Map<string, EditedFile>()
  let failed: Record<string, number> = {}
  let spentAtStart: Record<string, number> = {}

  on('prompt.submit', async ($, e, next) => {
    startedAt = await $.clock.now()
    cwd = await $.session.cwd()
    inTurn = true
    ok = 0
    files = new Map()
    failed = {}
    spentAtStart = await measure($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    liveStatus($, e.tool, ok, countFails(failed))

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) {
      failed[e.tool] = (failed[e.tool] ?? 0) + 1
    } else if (ran.deny === undefined) {
      ok += 1
      const { file_path, notebook_path } = e as { file_path?: unknown; notebook_path?: unknown }
      const path = file_path ?? notebook_path
      if (EDITING.has(e.tool) && typeof path === 'string') {
        files.set(normalize(path), { name: baseName(path), path, isOutside: isOutsideOf(cwd, path) })
      }
    }
    liveStatus($, e.tool, ok, countFails(failed))

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    // A reload mid-turn drops startedAt and the counts: there is no turn to report.
    if (!inTurn) return next(e)
    inTurn = false
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    const spentNow = await measure($)
    const spent = Object.fromEntries(
      Object.entries(spentNow)
        .map(([kind, n]): [string, number] => [kind, n - (spentAtStart[kind] ?? n)])
        .filter(([, n]) => n >= 0.05),
    )
    const pulse: Pulse = { seconds, ok, files: [...files.values()], failed: { ...failed }, spent }
    await update($, last, () => pulse)
    idleStatus($, pulse, spentNow)

    const outside = pulse.files.filter(file => file.isOutside)
    const fails = countFails(failed)
    if (outside.length > 0) {
      $.ui.toast(`⚠ Edited outside ${cwd}: ${outside.map(file => file.path).join(', ')}`, { timeoutMs: 15000 })
    } else if (seconds >= TOAST_SECONDS) {
      const parts = [`Done in ${formatTime(seconds)}`, `${pulse.files.length} files edited`]
      if (fails > 0) parts.push(`${fails} failed`)
      $.ui.toast(parts.join(' · '), { timeoutMs: 10000 })
    }

    return next(e)
  })

  // Pushed when a window moves a whole point, also between turns.
  on('session.measure', async ($, e, next) => {
    const spent = await measure($, e.rateLimits)
    if (!inTurn) idleStatus($, await read($, last), spent)

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async ($, e, next) => {
    const isOn = await read($, isBandOn)
    const [word, choice, ...rest] = e.args.trim().split(/\s+/)

    if (word === 'band') {
      if ((choice !== undefined && choice !== 'on' && choice !== 'off') || rest.length > 0) {
        return { text: 'Usage: /pulse band [on|off]' }
      }
      const wanted = choice === undefined ? !isOn : choice === 'on'
      await setBand($, wanted)

      return { text: `Turn pulse band ${wanted ? 'on' : 'off'}.` }
    }
    if (word !== '') return { text: 'Usage: /pulse band [on|off]' }

    // Cloud sessions may draw neither the band nor the status line, so there
    // /pulse prints the last turn as text.
    if (!(await isCloud($))) {
      return { text: `Turn pulse band is ${isOn ? 'on' : 'off'}. Change it with /pulse band [on|off].` }
    }

    const pulse = await read($, last)
    // Measured now: the saved windows can trail by up to a point.
    const spent = await measure($)
    const lines = [isCurrent(pulse) ? summarize(pulse) : 'No turn has finished yet.']
    if (Object.keys(spent).length > 0) lines.push(`session: ${formatSpent(spent)}`)
    return { text: lines.join('\n') }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pulse',
      description: (await isCloud($)) ? 'Print the last turn summary' : 'Show the turn pulse band state',
      argumentHint: 'band [on|off]',
    })
    // Only a stored true turns the band on: anything else in the store means off.
    const isOn = (await $.store.get('isBandOn')) === true
    await update($, isBandOn, () => isOn)
    const spent = await measure($)
    const pulse = await read($, last)
    if (isCurrent(pulse)) idleStatus($, pulse, spent)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pulse = await read($, last)
    if (e.props.hasSurvey || !isCurrent(pulse) || !(await read($, isBandOn))) {
      return next(e)
    }

    // Other mods share this slot: draw theirs below ours instead of replacing it.
    // next(e) rejects only when nothing answers beneath (the test harness): the band still draws.
    const below = await next(e).catch(() => undefined)

    const { Box, Button, Text } = $.ui.resolve(e)
    const { outside, inside, shown, more, fails, failures, spent } = describe(pulse)

    const mine = (
      <Box flexDirection="row" gap={1}>
        <Text color="claude" bold>◆ last turn</Text>
        <Text color={pulse.seconds > SLOW_SECONDS ? 'warning' : 'success'}>⏱ {formatTime(pulse.seconds)}</Text>
        <Text dimColor>│</Text>
        {outside.length > 0 ? (
          <Text color="error" bold>⚠ outside: {outside.map(file => file.name).join(', ')}</Text>
        ) : null}
        {inside.length > 0 ? <Text color="diffAdded">✎ {shown}{more}</Text> : null}
        {pulse.files.length === 0 ? <Text dimColor>no edits</Text> : null}
        <Text dimColor>│</Text>
        <Text color="success">✓ {pulse.ok} ok</Text>
        {fails > 0 ? <Text color="error">✗ {fails} failed ({failures})</Text> : null}
        {Object.keys(spent).length > 0 ? <Text dimColor>│</Text> : null}
        {Object.keys(spent).length > 0 ? <Text color="suggestion">{formatSpent(spent)}</Text> : null}
        <Button key="hide" label="Hide" onPress={() => setBand($, false)} />
      </Box>
    )

    return below ? <Box flexDirection="column">{mine}{below}</Box> : mine
  })
}
