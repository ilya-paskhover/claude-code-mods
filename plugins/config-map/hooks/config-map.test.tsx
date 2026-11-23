import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  describeKey,
  findImports,
  isOnDemand,
  HIDDEN,
  joinPath,
  masked,
  modelsIn,
  resolveImport,
  shortPath,
  splitBlocks,
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

test('model tags come from headings and their parents; comment markers are ignored', () => {
  const by = Object.fromEntries(splitBlocks(CLAUDE_MD, 'f').map(b => [b.heading, b.models]))
  expect(by['Style']).toEqual([])
  expect(by['Opus 5.5 optional tuning']).toEqual(['Opus 5.5'])
  expect(by['Subagents']).toEqual(['Opus 5.5'])
  expect(by['Sonnet 5.5 additions']).toEqual(['Sonnet 5.5'])
  expect(by['Email']).toEqual(['Sonnet 5.5'])
})

test('model names normalize', () => {
  expect(modelsIn('claude-opus-5-5')).toEqual(['Opus 5.5'])
  expect(modelsIn('Opus 5.5 or sonnet-5.5, OPUS 5.5')).toEqual(['Opus 5.5', 'Sonnet 5.5'])
  expect(modelsIn('opus')).toEqual([])
})

test('model ids with a date stamp keep their version', () => {
  expect(modelsIn('claude-opus-4-20250514')).toEqual(['Opus 4'])
  expect(modelsIn('anthropic.claude-sonnet-4-20250514-v1:0')).toEqual(['Sonnet 4'])
  expect(modelsIn('claude-opus-4-1-20250805')).toEqual(['Opus 4.1'])
  expect(modelsIn('claude-sonnet-4-5-20250929')).toEqual(['Sonnet 4.5'])
  expect(modelsIn('claude-3-7-sonnet-20250219')).toEqual(['Sonnet 3.7'])
  expect(modelsIn('claude-3-haiku-20240307')).toEqual(['Haiku 3'])
  expect(modelsIn('Claude 3.5 Haiku, then Opus 5.5')).toEqual(['Haiku 3.5', 'Opus 5.5'])
  expect(modelsIn('sonnet-20250219')).toEqual([])
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

test('settings rows summarize; their values mask env and secret-looking keys', () => {
  expect(describeKey('env', { API_KEY: 'sk-secret' }).summary).toBe('API_KEY')
  expect(describeKey('env', { API_KEY: 'sk-secret' }).json.includes('sk-secret')).toBe(false)
  expect(describeKey('permissions', { allow: ['a', 'b'], deny: ['c'] }).summary).toBe('2 allow, 1 deny')
  expect(describeKey('hooks', { Stop: [], PreToolUse: [] }).summary).toBe('Stop, PreToolUse')
  expect(describeKey('apiKeyHelper', 'cat ~/key').summary).toBe(HIDDEN)
  expect(describeKey('model', 'opus').summary).toBe('opus')
  expect(masked('mcp', { github: { headers: { Authorization: 'Bearer x' }, url: 'u' } })).toEqual({
    github: { headers: { Authorization: HIDDEN }, url: 'u' },
  })
  expect(JSON.parse(describeKey('permissions', { allow: ['Bash(ls)'] }).json)).toEqual({ allow: ['Bash(ls)'] })
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
  on('command.register', () => ({ value: { command: 'config-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'C:\\work\\app', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'config-map', args: '' } as never)
  const text = (ran as { text?: string }).text ?? ''
  expect(text).toMatch(/4 instruction files, 5 blocks\./)
  expect(text).toMatch(/tagged for a model other than Sonnet 5\.5/)
  expect(text.includes('token')).toBe(false)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const md = (await ui.find({ type: 'Markdown' })) as { props: { text?: unknown } } | undefined
  const files = String(md?.props.text ?? '')
  expect(files).toMatch(/~\/\.claude\/models\/sonnet\.md/)
  expect(files).toMatch(/on demand/)
  expect(files.includes('token')).toBe(false)
  expect(await ui.findAll({ key: 'tab-extras' })).toHaveLength(0)

  // A block row folds and unfolds to show the block's own lines.
  const opusRow = 'b:C:/Users/dev/.claude/CLAUDE.md:4'
  expect((await ui.find({ key: opusRow }))?.text).toMatch(/Opus 5\.5 tuning.*L4-7 · Opus 5\.5 ⚠/)
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: opusRow })
  expect(String((await ui.find({ type: 'Code' }))?.props.source)).toBe('# Opus 5.5 tuning\nFocus.\n\n@models/sonnet.md')
  await ui.press({ key: 'fold' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()

  await ui.press({ key: 'tab-settings' })
  const table = String(((await ui.find({ type: 'Markdown' })) as { props: { text?: unknown } } | undefined)?.props.text)
  expect(table).toMatch(/\| user \| `~\/\.claude\/settings\.json` \| 2 \|/)
  expect(table).toMatch(/\| project \| .* \| empty or absent \|/)
  expect((await ui.find({ key: 's:user:env' }))?.text).toMatch(/TOKEN/)
  await ui.press({ key: 's:user:env' })
  const env = String((await ui.find({ type: 'Code' }))?.props.source)
  expect(env).toMatch(/TOKEN/)
  expect(env.includes('secret-value')).toBe(false)
  expect(JSON.stringify(await ui.drawn()).includes('secret-value')).toBe(false)
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
  expect(blocks[0]?.text).toBe('---\nIntro paragraph.\n---')
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
