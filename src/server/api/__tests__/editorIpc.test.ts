import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { resolveLiveIpcSocket, probeSocket } from '../editorIpc'

// Build a temp dir of fake vscode-ipc-*.sock files with controlled mtimes.
// `entries` is newest-listed-first for readability; we stamp mtimes descending.
function makeIpcDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ipc-test-'))
  let t = 2_000_000 // seconds; stamp each successive file 100s older
  for (const name of names) {
    const p = join(dir, name)
    writeFileSync(p, '')
    utimesSync(p, t, t)
    t -= 100
  }
  // also drop a non-socket file that must be ignored
  writeFileSync(join(dir, 'not-a-socket.txt'), '')
  return dir
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('resolveLiveIpcSocket', () => {
  it('skips the newest-by-mtime socket when it is dead and returns the newest LIVE one', async () => {
    // This is the regression: a recently-closed window left the newest file,
    // but its socket is dead. The live window owns an older file.
    const dir = makeIpcDir([
      'vscode-ipc-dead-newest.sock', // newest mtime, dead
      'vscode-ipc-live-older.sock',  // older, alive — must win
      'vscode-ipc-live-oldest.sock', // oldest, alive
    ])
    dirs.push(dir)
    const probe = async (p: string) => !p.includes('dead')
    const result = await resolveLiveIpcSocket({ dir, probe })
    expect(result).toBe(join(dir, 'vscode-ipc-live-older.sock'))
  })

  it('returns the newest socket when it is alive', async () => {
    const dir = makeIpcDir(['vscode-ipc-a.sock', 'vscode-ipc-b.sock'])
    dirs.push(dir)
    const result = await resolveLiveIpcSocket({ dir, probe: async () => true })
    expect(result).toBe(join(dir, 'vscode-ipc-a.sock'))
  })

  it('returns null when every socket is dead', async () => {
    const dir = makeIpcDir(['vscode-ipc-a.sock', 'vscode-ipc-b.sock'])
    dirs.push(dir)
    const result = await resolveLiveIpcSocket({ dir, probe: async () => false })
    expect(result).toBeNull()
  })

  it('returns null when the directory is missing', async () => {
    const result = await resolveLiveIpcSocket({ dir: '/no/such/dir/xyz', probe: async () => true })
    expect(result).toBeNull()
  })

  it('ignores non-vscode-ipc files', async () => {
    const dir = makeIpcDir(['vscode-ipc-only.sock'])
    dirs.push(dir)
    // probe rejects the txt path if it were ever offered; it should not be
    const result = await resolveLiveIpcSocket({ dir, probe: async (p) => p.endsWith('.sock') })
    expect(result).toBe(join(dir, 'vscode-ipc-only.sock'))
  })

  it('treats a probe that throws/rejects as not-live instead of rejecting', async () => {
    // A probe (incl. the real one, if createConnection throws synchronously on a
    // file unlinked mid-scan) must not reject the whole Promise.all and escape the
    // intended null fallback.
    const dir = makeIpcDir(['vscode-ipc-a.sock', 'vscode-ipc-b.sock'])
    dirs.push(dir)
    const throwing = () => { throw new Error('boom') }
    await expect(resolveLiveIpcSocket({ dir, probe: throwing })).resolves.toBeNull()
  })
})

describe('probeSocket (real connection)', () => {
  it('returns true for a live unix socket and false for a dead path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipc-probe-'))
    dirs.push(dir)
    const livePath = join(dir, 'live.sock')
    const server = createServer()
    await new Promise<void>((r) => server.listen(livePath, r))
    try {
      expect(await probeSocket(livePath)).toBe(true)
      expect(await probeSocket(join(dir, 'nonexistent.sock'))).toBe(false)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
