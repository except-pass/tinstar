import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'bin/tinstar-v6-view')

function runScript(args: string[], pathDir: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: `${pathDir}:${env.PATH ?? ''}`, TINSTAR_V6_VIEW_DIE_SLEEP: '0' }
  delete childEnv.TMUX
  return new Promise(resolve => {
    execFile(script, args, {
      env: childEnv,
      timeout: 5_000,
    }, (err, _stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : null
      resolve({ code, stderr: String(stderr ?? '') })
    })
  })
}

describe('tinstar-v6-view', () => {
  it('refuses protected names before calling tmux and links only through -L', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v6-fake-tmux-'))
    const log = join(dir, 'tmux.log')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nif [ "$3" = list-windows ]; then printf '%s\\n' '@7 alpha'; exit 0; fi\nexit 0\n`)
    chmodSync(join(dir, 'tmux'), 0o755)
    const env = { ...process.env }
    delete env.TMUX
    const refused = await runScript(['sock', 'firstmate', '@7', 'alpha'], dir, env)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toMatch(/refused session/)
    expect(() => readFileSync(log, 'utf8')).toThrow()

    const linked = await runScript(['sock', 'worker-a', '@7', 'alpha'], dir, env)
    expect(linked.code, linked.stderr).toBe(0)
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('-L sock')
    expect(text).toContain('link-window')
    expect(text).not.toContain('kill-server')
    expect(text).not.toContain('send-keys')
    expect(text).not.toMatch(/kill-session[^\n]*worker-a/)
    expect(text).toMatch(/kill-window -t =v6view-/)
  })

  // Attach needs a pty on Linux; without one tmux exits before the view session is visible.
  const ptyHelper = `
import os, pty, select, sys, signal, struct, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
def bye(*_):
    try: os.kill(pid, signal.SIGHUP)
    except Exception: pass
    os._exit(0)
signal.signal(signal.SIGTERM, bye)
sin = sys.stdin.fileno()
while True:
    try: r, _, _ = select.select([fd, sin], [], [])
    except Exception: break
    if fd in r:
        try:
            if not os.read(fd, 65536): break
        except OSError: break
    if sin in r:
        d = os.read(sin, 65536)
        if not d: bye()
        os.write(fd, d)
try: os.waitpid(pid, 0)
except Exception: pass
`

  function hasBin(name: string): boolean {
    try { execFileSync(name, ['-V'], { stdio: 'ignore' }); return true } catch { return false }
  }

  it.skipIf(!hasBin('tmux'))('leaves the private worker window alive after the view exits (skipped when tmux is not installed)', async () => {
    const socket = `tsv6${process.pid}`
    const sockDir = mkdtempSync(join(tmpdir(), 'v6-view-sock-'))
    const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: sockDir }
    delete env.TMUX
    delete env.TMUX_PANE
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' })
    let child: ChildProcess | null = null
    try {
      tmux('new-session', '-d', '-s', 'worker-a', '-n', 'alpha')
      const listing = tmux('list-windows', '-t', '=worker-a', '-F', '#{window_id} #{window_name}').trim()
      const [windowId, windowName] = listing.split(' ')
      expect(windowId).toMatch(/^@\d+$/)
      const viewArgs = [socket, 'worker-a', windowId!, windowName!]
      const viewEnv = { ...env, TINSTAR_V6_VIEW_DIE_SLEEP: '0', TERM: 'xterm-256color' }
      child = hasBin('python3')
        ? spawn('python3', ['-c', ptyHelper, script, ...viewArgs], { env: viewEnv, stdio: ['pipe', 'ignore', 'pipe'] })
        : spawn(script, viewArgs, { env: viewEnv, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      let seen = ''
      for (let i = 0; i < 50; i++) {
        seen = tmux('list-sessions', '-F', '#{session_name}')
        if (seen.includes('v6view-') && seen.includes('worker-a')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(seen, stderr).toContain('v6view-')
      expect(seen).toContain('worker-a')
      child.kill('SIGTERM')
      child = null
      await new Promise(resolve => setTimeout(resolve, 300))
      const after = tmux('list-sessions', '-F', '#{session_name}')
      expect(after).toContain('worker-a')
    } finally {
      try { child?.kill('SIGTERM') } catch { /* already gone */ }
      try { tmux('kill-server') } catch { /* private socket already gone */ }
      rmSync(sockDir, { recursive: true, force: true })
    }
  })
})
