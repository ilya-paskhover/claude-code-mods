// One heading-delimited block of an instruction file.
export type Block = {
  file: string
  line: number
  heading: string
  level: number
  tokens: number
  // Models the block is for: from a `<!-- model: ... -->` marker, a model
  // named in its heading, or a parent heading. Empty: every model.
  models: string[]
  category: string
}

// One instruction file that loads into context.
export type InstructionFile = {
  path: string
  scope: 'Managed' | 'User' | 'Project' | 'Local' | 'Rule' | 'Import'
  tokens: number
  onDemand: boolean
  importedBy?: string
}

export type KeyRow = { key: string; size: number; summary: string }

export type SettingsFile = { source: string; path: string; keys: KeyRow[] }

export type NamedSize = { name: string; source: string; tokens: number }

export type Scan = {
  at: number
  home: string
  model: string
  files: InstructionFile[]
  blocks: Block[]
  settings: SettingsFile[]
  skills: NamedSize[]
  agents: NamedSize[]
  mcp: { server: string; tools: number; tokens: number }[]
  errors: string[]
}

export type Tab = 'instructions' | 'settings' | 'extras'

declare module 'claude-code' {
  interface PluginState {
    'config-map': { scan: Shaped<Scan | null>; tab: Tab; model: string }
  }
}
