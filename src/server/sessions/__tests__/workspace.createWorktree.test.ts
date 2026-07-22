import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorktree, worktreeDir } from '../workspace'

let scratch: string
let repo: string

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tinstar-wt-'))
  repo = join(scratch, 'repo')
  mkdirSync(repo)
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  git(['add', 'README.md'], repo)
  git(['commit', '-m', 'init'], repo)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('createWorktree .claude inheritance', () => {
  it('does not fail when .claude is already present (tracked + symlink)', async () => {
    const claude = join(repo, '.claude')
    mkdirSync(claude)
    writeFileSync(join(claude, 'settings.local.json'), '{}\n')
    // Broken absolute symlink — same shape that previously made cpSync throw EEXIST
    symlinkSync('/nonexistent/host/path/.claude/commands', join(claude, 'commands'))
    git(['add', '-f', '.claude'], repo)
    git(['commit', '-m', 'track claude'], repo)

    const wtPath = await createWorktree(repo, 'sess-tracked')
    expect(wtPath).toBe(worktreeDir(repo, 'sess-tracked'))
    expect(existsSync(join(wtPath, '.claude', 'settings.local.json'))).toBe(true)
  })

  it('copies untracked .claude from the base repo into a fresh worktree', async () => {
    const claude = join(repo, '.claude')
    mkdirSync(claude)
    writeFileSync(join(claude, 'settings.local.json'), '{"local":true}\n')

    const wtPath = await createWorktree(repo, 'sess-local')
    expect(existsSync(join(wtPath, '.claude', 'settings.local.json'))).toBe(true)
    expect(readFileSync(join(wtPath, '.claude', 'settings.local.json'), 'utf-8')).toBe(
      '{"local":true}\n',
    )
  })
})
