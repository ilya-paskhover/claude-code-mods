export type Note = {
  id: string
  text: string
  comment?: string
  createdAt: number
  // Where it was taken: the session's folder and id, and the transcript row.
  cwd: string
  sessionId: string
  requestId?: string
  done: boolean
  doneAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    notes: { notes: Note[]; showDone: boolean; sessionId: string; expanded: string[] }
  }
}
