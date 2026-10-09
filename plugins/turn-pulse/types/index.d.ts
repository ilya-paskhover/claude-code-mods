export type EditedFile = { name: string; path: string; isOutside: boolean }

export type Pulse = {
  seconds: number
  ok: number
  files: EditedFile[]
  failed: Record<string, number>
  // Points of each rate-limit window this turn used, by window kind.
  spent?: Record<string, number>
}

// One rate-limit window as this session has watched it.
export type WindowTrack = {
  start: number
  last: number
  carried: number
  resetsAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'turn-pulse': {
      last: Pulse | null
      isHidden: boolean
      windows: Record<string, WindowTrack>
    }
  }
}
