import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { listReviews, showReview, runAction } from './cli'

// execFile(file, args, opts, cb) — invoke cb(err, stdout, stderr) positional.
function resolveWith(stdout: string) {
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Function) => {
    cb(null, stdout, '')
  })
}
function rejectWith(err: Error) {
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Function) => {
    cb(err, '', 'boom')
  })
}

// Brace the body so beforeEach returns undefined. `mockReset()` returns the mock
// for chaining; returning it would register the mock as a Vitest teardown hook,
// which then calls execFile with 0 args after each test.
beforeEach(() => { execFileMock.mockReset() })

describe('listReviews', () => {
  it('runs `roborev list --json` with cwd=repo and parses the array', async () => {
    resolveWith(JSON.stringify([{ id: 1, status: 'done', verdict: 'P', closed: false, branch: 'b', repo_path: '/r', repo_name: 'r', commit_subject: 's', git_ref: 'abc', finished_at: null }]))
    const out = await listReviews('/repo/path')
    expect(execFileMock).toHaveBeenCalledWith('roborev', ['list', '--json'], expect.objectContaining({ cwd: '/repo/path' }), expect.any(Function))
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe(1)
  })

  it('returns [] for empty stdout', async () => {
    resolveWith('')
    expect(await listReviews('/r')).toEqual([])
  })

  it('throws a labeled error on non-zero exit', async () => {
    rejectWith(new Error('exit 1'))
    await expect(listReviews('/r')).rejects.toThrow(/roborev list failed/)
  })
})

describe('showReview', () => {
  it('runs `roborev show --job <id> --json`', async () => {
    resolveWith(JSON.stringify({ id: 9, job_id: 1, output: 'No issues found.', verdict_bool: 1, closed: false }))
    const out = await showReview('/r', 1)
    expect(execFileMock).toHaveBeenCalledWith('roborev', ['show', '--job', '1', '--json'], expect.objectContaining({ cwd: '/r' }), expect.any(Function))
    expect(out.output).toContain('No issues')
  })

  it('throws a labeled error on non-zero exit', async () => {
    rejectWith(new Error('exit 1'))
    await expect(showReview('/r', 1)).rejects.toThrow(/roborev show failed/)
  })
})

describe('runAction', () => {
  it('close → `roborev close <id>`', async () => {
    resolveWith('closed')
    await runAction('/r', { jobId: 5, action: 'close' })
    expect(execFileMock).toHaveBeenCalledWith('roborev', ['close', '5'], expect.objectContaining({ cwd: '/r' }), expect.any(Function))
  })
  it('reopen → `roborev close <id> --reopen`', async () => {
    resolveWith('reopened')
    await runAction('/r', { jobId: 5, action: 'reopen' })
    expect(execFileMock).toHaveBeenCalledWith('roborev', ['close', '5', '--reopen'], expect.objectContaining({ cwd: '/r' }), expect.any(Function))
  })
  it('comment → `roborev comment --job <id> -m <msg>`', async () => {
    resolveWith('ok')
    await runAction('/r', { jobId: 5, action: 'comment', message: 'hi there' })
    expect(execFileMock).toHaveBeenCalledWith('roborev', ['comment', '--job', '5', '-m', 'hi there'], expect.objectContaining({ cwd: '/r' }), expect.any(Function))
  })
  it('comment with empty message rejects before spawning', async () => {
    await expect(runAction('/r', { jobId: 5, action: 'comment', message: '  ' })).rejects.toThrow(/message required/)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
