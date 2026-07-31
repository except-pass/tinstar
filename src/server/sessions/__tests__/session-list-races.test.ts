import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import { createSession, listSessions, setState } from '../session'

const roots: string[] = []

afterEach(() => {
  execFileMock.mockReset()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('listSessions concurrency', () => {
  it('drops a deletion-marked session while branch detection is pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-session-list-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, '.git'), { recursive: true })
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    createSession(sessionsDir, {
      name: 'deleted-during-branch-read',
      backend: 'tmux',
      workspace: { path: workspace },
    })
    setState(sessionsDir, 'deleted-during-branch-read', 'running')

    let finishBranch!: () => void
    execFileMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishBranch = () => resolve({ stdout: 'main\n', stderr: '' })
      }),
    )
    const listing = listSessions(sessionsDir)
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled())

    writeFileSync(
      join(sessionsDir, 'deleted-during-branch-read', '.deleting'),
      '',
    )
    finishBranch()

    await expect(listing).resolves.toEqual([])
  })

  it('returns the current stopped state after branch detection yields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-session-list-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, '.git'), { recursive: true })
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    createSession(sessionsDir, {
      name: 'stopped-during-branch-read',
      backend: 'tmux',
      workspace: { path: workspace },
    })
    setState(sessionsDir, 'stopped-during-branch-read', 'running')

    let finishBranch!: () => void
    execFileMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishBranch = () => resolve({ stdout: 'main\n', stderr: '' })
      }),
    )
    const listing = listSessions(sessionsDir)
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled())

    setState(sessionsDir, 'stopped-during-branch-read', 'stopped')
    finishBranch()

    await expect(listing).resolves.toEqual([
      expect.objectContaining({
        name: 'stopped-during-branch-read',
        state: 'stopped',
      }),
    ])
  })
})
