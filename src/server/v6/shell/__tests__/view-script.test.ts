import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    expect(linked.code).toBe(0)
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('-L sock')
    expect(text).toContain('link-window')
    expect(text).not.toContain('kill-server')
    expect(text).not.toContain('send-keys')
    expect(text).not.toMatch(/kill-session[^\n]*worker-a/)
    expect(text).toMatch(/kill-window -t =v6view-/)
  })

  it('leaves the private worker window alive after the view exits', async () => {
    let tmuxBin = 'tmux'
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    } catch {
      return
    }
    const socket = `tsv6${process.pid}`
    const env = { ...process.env }
    delete env.TMUX
    const tmux = (...args: string[]) => execFileSync(tmuxBin, ['-L', socket, ...args], { env, encoding: 'utf8' })
    try {
      tmux('new-session', '-d', '-s', 'worker-a', '-n', 'alpha')
      const listing = tmux('list-windows', '-t', '=worker-a', '-F', '#{window_id} #{window_name}').trim()
      const [windowId, windowName] = listing.split(' ')
      expect(windowId).toMatch(/^@\d+$/)
      const child = spawn(script, [socket, 'worker-a', windowId!, windowName!], {
        env: { ...env, TINSTAR_V6_VIEW_DIE_SLEEP: '0' },
        stdio: 'ignore',
      })
      let seen = ''
      for (let i = 0; i < 20; i++) {
        seen = tmux('list-sessions', '-F', '#{session_name}')
        if (seen.includes('v6view-') && seen.includes('worker-a')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(seen).toContain('v6view-')
      expect(seen).toContain('worker-a')
      child.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 200))
      const after = tmux('list-sessions', '-F', '#{session_name}')
      expect(after).toContain('worker-a')
    } finally {
      try { tmux('kill-server') } catch { /* private socket already gone */ }
    }
  })
})
