// @vitest-environment node
//
// bin/tinstar-run (U9 / R18): a shell wrapper that self-reports a long-running
// command onto the run's Slate by writing `.tinstar/slate/run-<pid>.json`. These
// tests shell out to the real script in throwaway temp worktrees and assert the
// contract that matters: the wrapped command's exit code and output are never
// disturbed by Slate reporting, and the surface finalizes to ✓/✗.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseA2uiContent } from '../../src/a2ui/schema'

const WRAPPER = resolve(__dirname, '../../bin/tinstar-run')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-run-'))
  mkdirSync(join(root, '.tinstar'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run the wrapper inside `cwd` and return its result. */
function run(args: string[], cwd = root) {
  return spawnSync('bash', [WRAPPER, ...args], { cwd, encoding: 'utf8' })
}

/** Read the single surface file the wrapper wrote in `dir`'s slate dir. */
function readSurface(dir = root): Record<string, unknown> {
  const slateDir = join(dir, '.tinstar', 'slate')
  const files = readdirSync(slateDir).filter((f) => f.startsWith('run-') && f.endsWith('.json'))
  expect(files).toHaveLength(1)
  const arr = JSON.parse(readFileSync(join(slateDir, files[0]!), 'utf8'))
  expect(Array.isArray(arr)).toBe(true)
  expect(arr).toHaveLength(1)
  return arr[0]
}

/** The status Text (third component) of a surface's A2UI body. */
function statusText(surface: Record<string, unknown>): string {
  const content = surface.content as { components: Array<{ id: string; text?: string }> }
  return content.components.find((c) => c.id === 'status')!.text ?? ''
}

describe('tinstar-run', () => {
  it('passes through stdout and a zero exit, and finalizes the surface to ✓', () => {
    const r = run(['sh', '-c', 'echo hello; exit 0'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('hello')

    const surface = readSurface()
    expect(surface.author).toBe('process')
    expect(surface.anchor).toEqual({ kind: 'surface' })
    expect(surface.id).toMatch(/^proc-\d+$/)
    expect(statusText(surface)).toContain('✓')
    // The body validates through the SAME funnel the watcher uses.
    expect(parseA2uiContent(surface.content)).not.toBeNull()
  })

  it('finalizes to ✗ with the exit code via the trap on a non-zero exit', () => {
    const r = run(['sh', '-c', 'echo oops >&2; exit 3'])
    expect(r.status).toBe(3) // the REAL exit code passes through
    expect(r.stderr).toContain('oops')

    const surface = readSurface()
    const status = statusText(surface)
    expect(status).toContain('✗')
    expect(status).toContain('3') // the exit code is reported
  })

  it('a Slate-write failure does NOT change the wrapped command exit code', () => {
    // Make the slate dir unwritable so every write fails; the command must still run
    // and return its real exit code (best-effort reporting).
    const slateDir = join(root, '.tinstar', 'slate')
    mkdirSync(slateDir, { recursive: true })
    chmodSync(slateDir, 0o500) // read+execute, no write
    try {
      const ok = run(['sh', '-c', 'echo still-ran; exit 0'])
      expect(ok.status).toBe(0)
      expect(ok.stdout).toContain('still-ran')

      const bad = run(['sh', '-c', 'exit 7'])
      expect(bad.status).toBe(7)
    } finally {
      chmodSync(slateDir, 0o700) // restore so afterEach cleanup can remove it
    }
  })

  it('still runs the command when there is no .tinstar/ dir and no git repo', () => {
    // A dir with neither `.tinstar/` nor a git toplevel: reporting is disabled but the
    // command runs and its exit code is preserved.
    const bare = mkdtempSync(join(tmpdir(), 'tinstar-run-bare-'))
    try {
      const r = spawnSync('bash', [WRAPPER, 'sh', '-c', 'echo bare; exit 5'], {
        cwd: bare, encoding: 'utf8',
        // Neutralize any ambient git repo above tmp so `git rev-parse` finds nothing.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
      })
      expect(r.status).toBe(5)
      expect(r.stdout).toContain('bare')
      expect(r.stderr).toContain('Slate reporting disabled')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('concurrent invocations write distinct pid-namespaced files', () => {
    const a = spawnSync('bash', ['-c',
      `"${WRAPPER}" sh -c 'sleep 0.3; exit 0' & "${WRAPPER}" sh -c 'sleep 0.3; exit 0' & wait`,
    ], { cwd: root, encoding: 'utf8' })
    expect(a.status).toBe(0)

    const slateDir = join(root, '.tinstar', 'slate')
    const files = readdirSync(slateDir).filter((f) => f.startsWith('run-') && f.endsWith('.json'))
    // Two wrappers → two distinct run-<pid>.json files.
    expect(files).toHaveLength(2)
    expect(new Set(files).size).toBe(2)
  })
})
