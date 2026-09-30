import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deliverKeys, deliverPrompt, PromptDeliveryError, type Tmux } from './promptInput'

function scripted(steps: Array<(args: string[]) => string | undefined>): { tmux: Tmux; calls: string[][] } {
  const calls: string[][] = []
  const tmux: Tmux = async args => {
    calls.push(args)
    const step = steps.shift()
    if (!step) throw new Error(`unexpected tmux ${args.join(' ')}`)
    const out = step(args)
    return out ?? ''
  }
  return { tmux, calls }
}

const livePane = (args: string[]) => {
  if (args[0] === 'list-panes') return '1 %7'
  if (args[0] === 'display-message') return '0'
  return ''
}

/** Fill #{pane_active} and #{pane_id} after rewriting controls to '_', which is
 *  what a tmux that will not print a tab in -F actually returns. */
function substitutingTmux(steps: Array<(args: string[]) => string | undefined> = []): { tmux: Tmux; calls: string[][] } {
  const calls: string[][] = []
  const tmux: Tmux = async args => {
    calls.push(args)
    if (args[0] === 'list-panes') {
      const fmt = args[args.indexOf('-F') + 1] ?? ''
      return fmt.replace(/[\u0000-\u001F\u007F]/g, '_').replaceAll('#{pane_active}', '1').replaceAll('#{pane_id}', '%255')
    }
    const step = steps.shift()
    return step?.(args) ?? ''
  }
  return { tmux, calls }
}

describe('deliverPrompt', () => {
  it('pastes the text into the worker pane and submits with Enter', async () => {
    const { tmux, calls } = scripted([livePane, livePane, () => '', () => '', () => ''])
    await deliverPrompt('firstmate:fm-alpha', 'hello composer', { tmux, settleMs: 0 })
    expect(calls[0]).toEqual(['list-panes', '-t', '=firstmate:fm-alpha', '-F', '#{pane_active} #{pane_id}'])
    expect(calls.some(args => args[0] === 'load-buffer')).toBe(true)
    const paste = calls.find(args => args[0] === 'paste-buffer')
    expect(paste).toEqual(['paste-buffer', '-d', '-r', '-p', '-b', expect.any(String), '-t', '%7'])
    expect(calls.at(-1)).toEqual(['send-keys', '-t', '%7', '', 'Enter'])
  })

  it('refuses a target that is not a worker window', async () => {
    const { tmux, calls } = scripted([])
    await expect(deliverPrompt('tsview-alpha:work', 'hi', { tmux, settleMs: 0 })).rejects.toBeInstanceOf(PromptDeliveryError)
    expect(calls).toEqual([])
  })

  it('pastes into the active pane when tmux rewrites a control character in -F to an underscore', async () => {
    const { tmux, calls } = substitutingTmux([() => '0', () => '', () => ''])
    await deliverPrompt('crew:work', 'hello', { tmux, settleMs: 0 })
    const paste = calls.find(args => args[0] === 'paste-buffer')
    expect(paste).toEqual(['paste-buffer', '-d', '-r', '-p', '-b', expect.any(String), '-t', '%255'])
  })

  it('chooses the active pane when several are listed', async () => {
    const { tmux, calls } = scripted([
      () => '0 %1\n1 %9\n',
      () => '0',
      () => '',
      () => '',
      () => '',
    ])
    await deliverPrompt('crew:work', 'hello', { tmux, settleMs: 0 })
    expect(calls.find(args => args[0] === 'paste-buffer')?.at(-1)).toBe('%9')
  })

  it('cancels copy mode before pasting', async () => {
    let probes = 0
    const { tmux, calls } = scripted([
      livePane,
      () => { probes += 1; return probes === 1 ? '1' : '0' },
      () => '',
      () => '',
      () => '',
      () => '',
      () => '',
      () => '',
    ])
    await deliverPrompt('crew:work', 'after scroll', { tmux, settleMs: 0 })
    expect(calls.some(args => args.join(' ') === 'send-keys -X cancel -t %7')).toBe(true)
    expect(calls.findIndex(args => args[0] === 'paste-buffer')).toBeGreaterThan(calls.findIndex(args => args.includes('cancel')))
  })
})

describe('deliverKeys', () => {
  it('sends one composer key to the pane', async () => {
    const { tmux, calls } = scripted([livePane, livePane, () => ''])
    await deliverKeys('crew:work', ['y'], { tmux })
    expect(calls.at(-1)).toEqual(['send-keys', '-t', '%7', 'y'])
  })

  it('rejects a key the composer does not send', async () => {
    const { tmux } = scripted([])
    await expect(deliverKeys('crew:work', ['C-c'], { tmux })).rejects.toBeInstanceOf(PromptDeliveryError)
  })
})

describe('deliverPrompt on a private tmux server', () => {
  it('pastes a short line into a scratch window', async () => {
    const real = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
    // macOS socket paths are short; os.tmpdir() under /var/folders is already too long.
    const dir = mkdtempSync(join('/tmp', 'tsprompt-'))
    const socket = `tsp${process.pid}`
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${real}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    const saved = {
      PATH: process.env.PATH,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TMUX_TMPDIR: dir }
    delete env.TMUX
    delete env.TMUX_PANE
    const tm = (...args: string[]) => execFileSync(real, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' })
    const outFile = join(dir, 'got')
    try {
      process.env.PATH = env.PATH
      process.env.TMUX_TMPDIR = dir
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      const script = `while IFS= read -r line; do printf '%s\\n' "$line" >> '${outFile}'; done`
      tm('new-session', '-d', '-s', 'scratch', '-n', 'pane', 'sh', '-c', script)
      await deliverPrompt('scratch:pane', 'hello-from-composer', { settleMs: 150 })
      const deadline = Date.now() + 3000
      let got = ''
      while (Date.now() < deadline) {
        try { got = readFileSync(outFile, 'utf8') } catch { got = '' }
        if (got.includes('hello-from-composer')) break
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      expect(got.trim()).toBe('hello-from-composer')
    } finally {
      try { tm('kill-server') } catch { /* already gone */ }
      if (saved.PATH === undefined) delete process.env.PATH
      else process.env.PATH = saved.PATH
      if (saved.TMUX === undefined) delete process.env.TMUX
      else process.env.TMUX = saved.TMUX
      if (saved.TMUX_PANE === undefined) delete process.env.TMUX_PANE
      else process.env.TMUX_PANE = saved.TMUX_PANE
      if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR
      else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

