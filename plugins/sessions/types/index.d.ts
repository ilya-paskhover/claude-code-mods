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

// The fields of a notes-mod note this mod reads (read-only) to show open
// notes under the sessions, while mod panes can't sit side by side (#5).
export type NoteSummary = {
  id: string
  text: string
  cwd: string
  createdAt: number
  done: boolean
}

declare module 'claude-code' {
  interface PluginState {
    sessions: { rows: SessionRow[]; sessionId: string; now: number; error: string }
    notes: { notes: NoteSummary[] }
  }
}
