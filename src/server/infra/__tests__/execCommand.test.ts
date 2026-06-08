import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { execCommand } from '../execCommand'

beforeEach(() => { execFileMock.mockReset() })

function cb(err: unknown, stdout: string, stderr: string) {
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, c: Function) => c(err, stdout, stderr))
}

describe('execCommand', () => {
  it('runs argv[0] with the rest as args and cwd, resolving code 0', async () => {
    cb(null, 'OUT', '')
    const r = await execCommand(['roborev', 'list', '--json'], { cwd: '/repo' })
    expect(execFileMock).toHaveBeenCalledWith('roborev', ['list', '--json'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function))
    expect(r).toEqual({ stdout: 'OUT', stderr: '', code: 0 })
  })
  it('resolves with the non-zero exit code (does not reject)', async () => {
    const err = Object.assign(new Error('exit 2'), { code: 2 })
    cb(err, 'partial', 'boom')
    const r = await execCommand(['x'], { cwd: '/repo' })
    expect(r).toEqual({ stdout: 'partial', stderr: 'boom', code: 2 })
  })
  it('rejects on spawn failure (ENOENT)', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    cb(err, '', '')
    await expect(execCommand(['nope'], { cwd: '/repo' })).rejects.toThrow(/not found|ENOENT/)
  })
  it('rejects empty argv before spawning', async () => {
    await expect(execCommand([], { cwd: '/repo' })).rejects.toThrow(/argv/)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
