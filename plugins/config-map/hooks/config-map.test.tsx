import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  categoryOf,
  describeKey,
  findImports,
  isOnDemand,
  joinPath,
  mcpServers,
  modelsIn,
  resolveImport,
  shortPath,
  splitBlocks,
  tokens,
} from './scan'

const CLAUDE_MD = `Intro line.

# Style
Lead with the answer.

# Opus 5.5 optional tuning
<!-- category: Reporting -->
- Focus

## Subagents
One per module.

# Sonnet 5.5 additions
Run real checks.

\`\`\`
# not a heading
@not/an/import.md
\`\`\`

## Email
<!-- model: opus-5.5, sonnet-5.5 -->
Ask before reading email.

See @models/opus.md and @~/shared/rules.md, mail me at a@b.com, \`@inline/code.md\`.
`

test('splits at headings, outside code fences', () => {
  const blocks = splitBlocks(CLAUDE_MD, 'C:/Users/dev/.claude/CLAUDE.md')
  expect(blocks.map(b => b.heading)).toEqual([
    '(top of file)',
    'Style',
    'Opus 5.5 optional tuning',
    'Subagents',
    'Sonnet 5.5 additions',
    'Email',
  ])
  expect(blocks.map(b => b.line)).toEqual([1, 3, 6, 10, 13, 21])
})

test('model tags come from headings, markers and parents', () => {
  const by = Object.fromEntries(splitBlocks(CLAUDE_MD, 'f').map(b => [b.heading, b.models]))
  expect(by['Style']).toEqual([])
  expect(by['Opus 5.5 optional tuning']).toEqual(['Opus 5.5'])
  expect(by['Subagents']).toEqual(['Opus 5.5'])
  expect(by['Sonnet 5.5 additions']).toEqual(['Sonnet 5.5'])
  expect(by['Email']).toEqual(['Opus 5.5', 'Sonnet 5.5'])
})

test('model names normalize', () => {
  expect(modelsIn('claude-opus-5-5')).toEqual(['Opus 5.5'])
  expect(modelsIn('Opus 5.5 or sonnet-5.5, OPUS 5.5')).toEqual(['Opus 5.5', 'Sonnet 5.5'])
  expect(modelsIn('opus')).toEqual([])
})

test('categories: marker first, then heading, then body', () => {
  expect(categoryOf('Opus tuning', '<!-- category: Reporting -->\nsubagent')).toBe('Reporting')
  expect(categoryOf('Git rules', 'never read .env')).toBe('Git')
  expect(categoryOf('Misc', 'Never read .env files')).toBe('Secrets')
  expect(categoryOf('Misc', 'nothing here')).toBe('General')
})

test('imports skip code, emails and inline code', () => {
  expect(findImports(CLAUDE_MD)).toEqual(['models/opus.md', '~/shared/rules.md'])
})

test('paths join on Windows and POSIX', () => {
  expect(joinPath('C:\\Users\\dev\\.claude', 'rules/../CLAUDE.md')).toBe('C:/Users/dev/.claude/CLAUDE.md')
  expect(joinPath('/home/dev/proj', '.claude/rules')).toBe('/home/dev/proj/.claude/rules')
  expect(resolveImport('~/x.md', '/p/CLAUDE.md', '/home/dev')).toBe('/home/dev/x.md')
  expect(resolveImport('../y.md', 'C:/p/q/CLAUDE.md', 'C:/Users/dev')).toBe('C:/p/y.md')
  expect(shortPath('C:\\Users\\Dev\\.claude\\CLAUDE.md', 'C:/Users/dev')).toBe('~/.claude/CLAUDE.md')
})

test('rules with paths frontmatter load on demand', () => {
  expect(isOnDemand('---\npaths:\n  - "src/**"\n---\nbody')).toBe(true)
  expect(isOnDemand('---\ndescription: x\n---\nbody')).toBe(false)
  expect(isOnDemand('no frontmatter')).toBe(false)
})

test('settings keys show counts, never values', () => {
  expect(describeKey('env', { API_KEY: 'sk-secret' }).summary).toBe('1 variables')
  expect(describeKey('permissions', { allow: ['a', 'b'], deny: ['c'] }).summary).toBe('2 allow, 1 deny')
  expect(describeKey('hooks', { Stop: [], PreToolUse: [] }).summary).toBe('Stop, PreToolUse')
  expect(describeKey('apiKeyHelper', 'cat ~/key').summary).toBe('text, 9 chars')
  expect(describeKey('model', 'opus').summary).toBe('opus')
})

test('tokens weigh non-ASCII heavier', () => {
  expect(tokens('abcd')).toBe(1)
  expect(tokens('абвг')).toBe(2)
})

test('MCP tools group by server', () => {
  const rows = mcpServers([
    { name: 'mcp__github__get_me', description: 'x', mcp: true },
    { name: 'mcp__github__list', description: 'y', mcp: true },
    { name: 'Bash', description: 'z', mcp: false },
  ])
  expect(rows.map(r => [r.server, r.tools])).toEqual([['github', 2]])
})

const PANE = {
  plugin: 'config-map',
  component: 'Pane',
  requestId: 'config-map',
  props: {
    title: 'Config map',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const norm = (e: unknown) => (e as { path?: string }).path?.replace(/\\/g, '/').replace(/^.*?(?=C:\/)/, '') ?? ''

test('/config-map scans a Windows home and draws the pane', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\dev' })
  mock.clock(on, { now: 1 })
  const tree: Record<string, string> = {
    'C:/Users/dev/.claude/CLAUDE.md': '# Style\nShort.\n\n# Opus 5.5 tuning\nFocus.\n\n@models/sonnet.md\n',
    'C:/Users/dev/.claude/models/sonnet.md': '# Sonnet 5.5 additions\nChecks.\n',
    'C:/Users/dev/.claude/rules/git.md': '---\npaths:\n  - "**/*.ts"\n---\n# Git\nNo push.\n',
    'C:/work/app/CLAUDE.md': '# Project\nUse pnpm.\n',
  }
  on('fs.read', (_, e) => {
    const text = tree[norm(e)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e)
    if (dir !== 'C:/Users/dev/.claude/rules') throw new Error('ENOENT')
    return { value: [{ name: 'git.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
  })
  on('fs.ancestors', () => ({ value: [{ dir: 'C:\\work\\app', name: 'CLAUDE.md', content: '', parts: [] }] }))
  on('session.root', () => ({ value: 'C:\\work\\app' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('settings.read', (_, e) =>
    ({ value: (e as { source?: string }).source === 'user' ? { env: { TOKEN: 'secret-value' }, model: 'opus' } : {} }),
  )
  on('command.list', () => ({ value: [{ name: 'note', description: 'Save a note', source: 'plugin', plugin: 'notes' }] }))
  on('tool.list', () => ({ value: [{ name: 'mcp__github__get_me', description: 'Me', mcp: true }] }))
  on('command.register', () => ({ value: { command: 'config-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'C:\\work\\app', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'config-map', args: '' } as never)
  const text = (ran as { text?: string }).text ?? ''
  expect(text).toMatch(/4 instruction files, 5 blocks/)
  expect(text).toMatch(/tagged for a model other than Sonnet 5\.5/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const md = (await ui.find({ type: 'Markdown' })) as { props: { text?: unknown } } | undefined
  const body = String(md?.props.text ?? '')
  expect(body).toMatch(/~\/\.claude\/models\/sonnet\.md/)
  expect(body).toMatch(/on demand/)
  expect(body).toMatch(/Opus 5\.5 ⚠/)

  await ui.press({ key: 'tab-settings' })
  const md2 = (await ui.find({ type: 'Markdown' })) as { props: { text?: unknown } } | undefined
  const settings = String(md2?.props.text ?? '')
  expect(settings).toMatch(/1 variables/)
  expect(settings.includes('secret-value')).toBe(false)
  await ui.unmount()
})

test('fences close only on the same character, at least as long', () => {
  const text = [
    '# Real',
    '````md',
    '```',
    '# inside a four-backtick fence',
    '```',
    '````',
    '# After four',
    '```',
    '~~~',
    '# inside despite tildes',
    '```',
    '# After three',
    'see `@inline.md` and ```@also/inline.md```',
  ].join('\n')
  expect(splitBlocks(text, 'f').map(b => b.heading)).toEqual(['Real', 'After four', 'After three'])
  expect(findImports('````\n```\n@in/code.md\n```\n````\n@out/side.md')).toEqual(['out/side.md'])
})

test('a file opening with a horizontal rule keeps its text', () => {
  const text = '---\nIntro paragraph.\n---\n# Heading\nBody.'
  const blocks = splitBlocks(text, 'f')
  expect(blocks[0]?.heading).toBe('(top of file)')
  expect(blocks[0]?.tokens).toBeGreaterThan(3)
  // Real frontmatter is still dropped.
  expect(splitBlocks('---\npaths:\n  - "a"\n---\n# H\nx', 'f').map(b => b.heading)).toEqual(['H'])
})

const late = (on: On) => {
  mock.env(on, { HOME: '/home/dev' })
  mock.clock(on, { now: 1 })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('fs.ancestors', () => ({ value: [] }))
  on('session.root', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('command.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const registered: string[] = []
  on('command.register', (_, e) => {
    registered.push((e as { name: string }).name)
    return { value: { command: 'config-map' } }
  })
  const reached: string[] = []
  on('prompt.submit', (_, e) => {
    reached.push(e.text)
    return { text: e.text }
  })
  return { registered, reached }
}

test('installed mid-session: the first prompt registers the command and answers /config-map', async ($, on) => {
  const { registered, reached } = late(on)
  // No session.start: the mod joined a session already running.
  const first = await $.prompt.submit({ text: '/config-map', origin: { kind: 'composer' } } as never)
  expect(registered).toEqual(['config-map'])
  expect((first as { drop?: string }).drop).toMatch(/^Config map: 0 instruction files/)
  expect(reached).toEqual([])

  // Once registered, prompts pass through untouched.
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never)
  expect(reached).toEqual(['hello'])
  expect(registered).toEqual(['config-map'])
})

test('a peer message reading /config-map is not run as the command', async ($, on) => {
  const { registered, reached } = late(on)
  await $.prompt.submit({ text: '/config-map', origin: { kind: 'peer' } } as never)
  expect(registered).toEqual(['config-map'])
  expect(reached).toEqual(['/config-map'])
})

test('a session that missed session.start registers the command on its first prompt', async ($, on) => {
  const { registered, reached } = late(on)
  const r = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never)
  expect((r as { text?: string }).text).toBe('hello')
  await $.prompt.submit({ text: 'again', origin: { kind: 'composer' } } as never)
  expect(registered).toEqual(['config-map'])
  expect(reached).toEqual(['hello', 'again'])
})
