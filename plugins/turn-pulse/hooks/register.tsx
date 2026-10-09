import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { EditedFile, Pulse, WindowTrack } from '../types'

const last = atom({ plugin: 'turn-pulse', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'turn-pulse', key: 'isHidden' } as const, false)
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

function idleStatus($: EngineInterface, spent: Record<string, number>) {
  $.ui.status(Object.keys(spent).length > 0 ? `session: ${formatSpent(spent)}` : undefined)
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
      const path = (e as { file_path?: unknown }).file_path
      if (EDITING.has(e.tool) && typeof path === 'string') {
        files.set(normalize(path), { name: baseName(path), path, isOutside: isOutsideOf(cwd, path) })
      }
    }
    liveStatus($, e.tool, ok, countFails(failed))

    return ran
  })

  on('turn.complete', async ($, e, next) => {
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
    idleStatus($, spentNow)

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
    if (!inTurn) idleStatus($, spent)

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async ($, e, next) => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)

    return { text: hidden ? 'Turn pulse band shown.' : 'Turn pulse band hidden.' }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse', description: 'Show or hide the turn pulse band' })
    idleStatus($, await measure($))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pulse = await read($, last)
    // A pulse saved by an older version of this mod has another shape: skip it.
    const isCurrent = pulse !== null && typeof pulse.ok === 'number'
    if (e.props.hasSurvey || !isCurrent || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const outside = pulse.files.filter(file => file.isOutside)
    const inside = pulse.files.filter(file => !file.isOutside)
    const shown = inside.slice(0, 3).map(file => file.name).join(', ')
    const more = inside.length > 3 ? ` +${inside.length - 3}` : ''
    const failures = Object.entries(pulse.failed)
      .map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool))
      .join(', ')
    const fails = countFails(pulse.failed)
    const spent = pulse.spent ?? {}

    return (
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
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
