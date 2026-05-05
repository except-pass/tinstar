import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSlashCommands, SlashCommandRegistry } from '../slashCommandRegistry'

let home: string
let cwd: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'slash-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'slash-cwd-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function write(path: string, contents: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

describe('discoverSlashCommands', () => {
  it('reads ~/.claude/commands/*.md', async () => {
    write(join(home, '.claude/commands/foo.md'), '---\ndescription: do foo\n---\nbody')
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'foo')).toMatchObject({
      name: 'foo', description: 'do foo', source: 'user',
    })
  })
  it('reads ~/.claude/skills/*/SKILL.md and uses dir name', async () => {
    write(
      join(home, '.claude/skills/my-skill/SKILL.md'),
      '---\nname: my-skill\ndescription: my skill desc\n---\nbody',
    )
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'my-skill')).toMatchObject({
      name: 'my-skill', description: 'my skill desc', source: 'user-skill',
    })
  })
  it('namespaces plugin skills as <plugin>:<skill>', async () => {
    write(
      join(home, '.claude/plugins/cache/marketplaceX/superpowers/1.0.0/skills/brainstorming/SKILL.md'),
      '---\nname: brainstorming\ndescription: brainstorm\n---\n',
    )
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'superpowers:brainstorming')).toMatchObject({
      source: 'plugin-skill',
    })
  })
  it('reads project commands from <cwd>/.claude/commands', async () => {
    write(join(cwd, '.claude/commands/local.md'), '---\ndescription: local\n---\n')
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'local')).toMatchObject({ source: 'project' })
  })
  it('returns empty array when nothing exists', async () => {
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds).toEqual([])
  })
  it('falls back to filename when frontmatter has no description', async () => {
    write(join(home, '.claude/commands/noDesc.md'), '# heading\n')
    const cmds = await discoverSlashCommands({ home, cwd })
    const cmd = cmds.find(c => c.name === 'noDesc')!
    expect(cmd.description).toBe('')
  })
})

describe('SlashCommandRegistry caching', () => {
  it('caches and invalidates on file change', async () => {
    write(join(home, '.claude/commands/a.md'), '---\ndescription: A\n---\n')
    const reg = new SlashCommandRegistry({ home, cwd })
    const first = await reg.list()
    expect(first.find(c => c.name === 'a')).toBeTruthy()

    // Same call returns cached (no rescan), still finds 'a'.
    const second = await reg.list()
    expect(second).toEqual(first)

    // Add another file, then call invalidate(); next list() rescans.
    write(join(home, '.claude/commands/b.md'), '---\ndescription: B\n---\n')
    reg.invalidate()
    const third = await reg.list()
    expect(third.find(c => c.name === 'b')).toBeTruthy()

    reg.dispose()
  })
})
