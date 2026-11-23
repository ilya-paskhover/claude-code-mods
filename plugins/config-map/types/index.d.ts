// One heading-delimited block of an instruction file.
export type Block = {
  file: string
  line: number
  heading: string
  level: number
  // The block's own lines, heading included, as the file has them.
  text: string
  // Models the block is for: named in its heading or a parent heading.
  // Empty: every model.
  models: string[]
}

// One instruction file that loads into context.
export type InstructionFile = {
  path: string
  scope: 'Managed' | 'User' | 'Project' | 'Local' | 'Rule' | 'Import'
  onDemand: boolean
  importedBy?: string
}

// One settings key: a one-line summary, and its value as JSON with env values
// and secret-looking keys masked.
export type KeyRow = { key: string; summary: string; json: string }

export type SettingsFile = { source: string; path: string; keys: KeyRow[] }

export type Scan = {
  at: number
  home: string
  model: string
  files: InstructionFile[]
  blocks: Block[]
  settings: SettingsFile[]
  errors: string[]
}

export type Tab = 'instructions' | 'settings'

declare module 'claude-code' {
  interface PluginState {
    'config-map': {
      scan: Shaped<Scan | null>
      tab: Tab
      model: string
      // Unfolded rows: `b:<file>:<line>` for a block, `s:<source>:<key>` for a setting.
      open: string[]
    }
  }
}
