import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorkspaceFile } from '../workspaceFile'

const ROOT = join(tmpdir(), 'tinstar-workspace-file-' + process.pid)
const SESS_DIR = join(ROOT, 'sessions')
const WS = join(ROOT, 'workspace')

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(SESS_DIR, 'sess-a'), { recursive: true })
  mkdirSync(join(WS, 'docs'), { recursive: true })
  writeFileSync(join(SESS_DIR, 'sess-a', 'session.json'), JSON.stringify({
    name: 'sess-a',
    workspace: { path: WS },
  }))
  writeFileSync(join(WS, 'docs', 'hello.txt'), 'hi there')
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('resolveWorkspaceFile', () => {
  it('resolves a valid relative path inside the workspace', () => {
    const r = resolveWorkspaceFile(SESS_DIR, 'sess-a', 'docs/hello.txt')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.filename).toBe('hello.txt')
    expect(r.rel).toBe('docs/hello.txt')
    expect(r.abs).toBe(join(WS, 'docs', 'hello.txt'))
    expect(r.wsRoot).toBe(WS)
    expect(r.size).toBe('hi there'.length)
  })

  it('rejects an unknown session', () => {
    const r = resolveWorkspaceFile(SESS_DIR, 'ghost', 'docs/hello.txt')
    expect(r).toEqual({ ok: false, code: 'SESSION_NOT_FOUND', message: expect.any(String) })
  })

  it('rejects a missing path', () => {
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', null).ok).toBe(false)
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', null)).toMatchObject({ code: 'INVALID_PARAMS' })
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', '')).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('rejects a relative path that escapes the workspace', () => {
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', '../escape.txt')).toMatchObject({
      ok: false, code: 'PATH_OUTSIDE_WORKSPACE',
    })
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', '../../etc/passwd')).toMatchObject({
      ok: false, code: 'PATH_OUTSIDE_WORKSPACE',
    })
  })

  it('rejects an absolute path outside the workspace', () => {
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', '/etc/passwd')).toMatchObject({
      ok: false, code: 'PATH_OUTSIDE_WORKSPACE',
    })
  })

  it('rejects the workspace root itself (not a file)', () => {
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', '.')).toMatchObject({
      ok: false, code: 'INVALID_PARAMS',
    })
  })

  it('404s a nonexistent file inside the workspace', () => {
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', 'docs/nope.txt')).toMatchObject({
      ok: false, code: 'NOT_FOUND',
    })
  })

  it('rejects a directory inside the workspace', () => {
    expect(resolveWorkspaceFile(SESS_DIR, 'sess-a', 'docs')).toMatchObject({
      ok: false, code: 'INVALID_PARAMS',
    })
  })

  it('keeps the containment check working when the workspace path has a trailing slash', () => {
    // Re-point the session workspace at a trailing-slash variant.
    writeFileSync(join(SESS_DIR, 'sess-a', 'session.json'), JSON.stringify({
      name: 'sess-a',
      workspace: { path: WS + '/' },
    }))
    const r = resolveWorkspaceFile(SESS_DIR, 'sess-a', 'docs/hello.txt')
    expect(r.ok).toBe(true)
  })
})
