import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLiveIpcSocket } from '../editorIpc'

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
})
