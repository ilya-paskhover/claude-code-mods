// One session, as Claude Code's own ~/.claude/sessions/<pid>.json describes
// it, or in a cloud session as the claude-code-remote server's list_sessions
// does (no pid, no folder).
export type SessionRow = {
  id: string
  pid?: number
  name: string
  cwd: string
  status: string
  updatedAt: number
  // The desktop app's id for a session it started: what a switch link opens.
  hostSessionId?: string
  // A cloud session's page on claude.ai: what Open goes to.
  url?: string
  // What a blocked cloud session is waiting on, as that session put it.
  needs?: string
}

declare module 'claude-code' {
  interface PluginState {
    sessions: {
      rows: SessionRow[]
      sessionId: string
      now: number
      error: string
      autoOpened: boolean
      cloud: boolean
    }
  }
}
