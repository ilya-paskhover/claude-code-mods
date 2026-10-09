// One running session, as Claude Code's own ~/.claude/sessions/<pid>.json
// describes it.
export type SessionRow = {
  id: string
  pid: number
  name: string
  cwd: string
  status: string
  updatedAt: number
  entrypoint?: string
}

declare module 'claude-code' {
  interface PluginState {
    sessions: { rows: SessionRow[]; sessionId: string; now: number; error: string }
  }
}
