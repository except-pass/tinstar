import { readdirSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'

/** Default location of VS Code / Cursor CLI IPC sockets on Linux. Honors
 *  XDG_RUNTIME_DIR so a server running as a non-1000 UID still finds them. */
const IPC_DIR = process.env.XDG_RUNTIME_DIR ?? '/run/user/1000'

/**
 * Probe a unix-domain socket for liveness: connect, then immediately close.
 * Resolves true only if the connection is accepted. A dead socket file (its
 * owning window has closed) refuses the connection and resolves false; the
 * timeout guards against a socket that accepts but never completes the handshake.
 * A synchronous throw from createConnection (e.g. the file vanished mid-scan)
 * also resolves false rather than escaping the executor.
 */
export function probeSocket(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (live: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      sock?.destroy()
      resolve(live)
    }
    let sock: ReturnType<typeof createConnection> | undefined
    try {
      sock = createConnection(path)
    } catch {
      resolve(false)
      return
    }
    timer = setTimeout(() => done(false), timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * Resolve the IPC socket the `code` CLI should talk to, returning its path or
 * null when no live editor window exists.
 *
 * VS Code / Cursor leave a stale socket FILE behind when a window closes, and a
 * recently-closed window's file can have a NEWER mtime than the live window's.
 * Picking "newest by mtime" therefore selects a dead socket and `code -g` fails
 * with ECONNREFUSED (silently — the editor never opens). We instead probe
 * candidates newest-first and return the newest one that actually accepts a
 * connection. Probing is cheap: a dead socket returns ECONNREFUSED immediately.
 */
export async function resolveLiveIpcSocket(
  opts: { dir?: string; probe?: (p: string) => Promise<boolean> } = {},
): Promise<string | null> {
  const dir = opts.dir ?? IPC_DIR
  const probe = opts.probe ?? probeSocket
  let candidates: { path: string; mtime: number }[]
  try {
    candidates = readdirSync(dir)
      .filter((f) => f.startsWith('vscode-ipc-') && f.endsWith('.sock'))
      // Per-entry stat is guarded: a single socket unlinked between readdir and
      // stat must skip that entry, not abort resolution of the other live ones.
      .flatMap((f) => {
        try { return [{ path: `${dir}/${f}`, mtime: statSync(`${dir}/${f}`).mtimeMs }] }
        catch { return [] }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return null // non-Linux, or the runtime dir does not exist
  }
  // A probe that throws synchronously or rejects is treated as not-live, so one bad
  // candidate can't reject Promise.all and bypass the null fallback.
  const safeProbe = (p: string): Promise<boolean> => {
    try { return Promise.resolve(probe(p)).catch(() => false) }
    catch { return Promise.resolve(false) }
  }
  // Probe all in parallel (order preserved), then take the newest live one.
  const liveness = await Promise.all(candidates.map((c) => safeProbe(c.path)))
  const idx = liveness.findIndex(Boolean)
  return idx >= 0 ? candidates[idx]!.path : null
}
