import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkWorktreeBranch,
  createWorktree,
  WorktreeBranchConflictError,
} from './workspace'

// Build a throwaway git repo with one commit so branches (refs) can exist.
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tinstar-wt-test-'))
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' })
  g('init', '-q')
  g('config', 'user.email', 'test@example.com')
  g('config', 'user.name', 'Test')
  g('commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}

function branch(dir: string, name: string): void {
  execFileSync('git', ['-C', dir, 'branch', name], { encoding: 'utf-8' })
}

let repo: string

beforeEach(() => {
  repo = initRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  // Clean up any worktree dir a create call may have made.
  rmSync(`${repo}-worktrees`, { recursive: true, force: true })
})

describe('checkWorktreeBranch', () => {
  it('returns action:create when no ref by that name exists', async () => {
    const result = await checkWorktreeBranch(repo, 'fresh')
    expect(result).toEqual({ ok: true, action: 'create' })
  })

  it('returns action:attach when an exact branch already exists', async () => {
    branch(repo, 'existing')
    const result = await checkWorktreeBranch(repo, 'existing')
    expect(result).toEqual({ ok: true, action: 'attach' })
  })

  it('reports a directory/file conflict when a sub-branch occupies the name (the "cockpit" bug)', async () => {
    // A branch `cockpit/soak-evidence` turns `cockpit` into a ref *directory*, so
    // a plain branch named `cockpit` cannot be created. This is the exact case
    // that produced the misleading "fatal: invalid reference: cockpit".
    branch(repo, 'cockpit/soak-evidence')
    const result = await checkWorktreeBranch(repo, 'cockpit')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected conflict')
    expect(result.conflict).toBe('cockpit/soak-evidence')
  })
})

describe('createWorktree', () => {
  it('throws a typed WorktreeBranchConflictError (not a raw git error) on a name collision', async () => {
    branch(repo, 'cockpit/soak-evidence')
    await expect(createWorktree(repo, 'cockpit')).rejects.toBeInstanceOf(WorktreeBranchConflictError)
    // The message names both the requested name and the blocking branch so the
    // user knows exactly why and what to do.
    await expect(createWorktree(repo, 'cockpit')).rejects.toThrow(/cockpit/)
    await expect(createWorktree(repo, 'cockpit')).rejects.toThrow(/cockpit\/soak-evidence/)
  })

  it('creates a fresh worktree branch when the name is clear', async () => {
    const wt = await createWorktree(repo, 'feature-x')
    expect(wt).toBe(join(`${repo}-worktrees`, 'feature-x'))
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'feature-x'], { encoding: 'utf-8' })
    expect(branches).toContain('feature-x')
  })
})
