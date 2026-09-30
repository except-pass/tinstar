// Types a prompt into a worker's tmux pane the way the old session composer did:
// leave copy-mode, paste the text as one literal buffer, then Enter.
// A prompt longer than PROMPT_TEXT_LIMIT is refused because a multi-megabyte
// paste fills the pane's input and stalls the worker.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseWindowRef } from '../firstmate/views'

const execFileAsync = promisify(execFile)

export type Tmux = (args: string[]) => Promise<string>

const chains = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(job, job)
  chains.set(key, run.then(() => {}, () => {}))
  return run
}

async function defaultTmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { timeout: 15_000, maxBuffer: 1024 * 1024 })
  return String(stdout ?? '')
}

/** Keys the composer sends. Anything else would be a tmux key-name injection. */
const COMPOSER_KEYS = new Set([
  '1', '2', '3', '4', '5', 'y', 'n',
  'Up', 'Down', 'Left', 'Right', 'Enter',
  'PageUp', 'PageDown', 'Escape',
])

export const PROMPT_TEXT_LIMIT = 100_000

export class PromptDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptDeliveryError'
  }
}

async function activePane(tmux: Tmux, target: string): Promise<string> {
  const ref = parseWindowRef(target)
  if (!ref) throw new PromptDeliveryError('not a tmux window target')
  const out = await tmux(['list-panes', '-t', `=${ref.session}:${ref.windowName}`, '-F', '#{pane_active}\t#{pane_id}'])
  const rows = out.split('\n').map(line => line.split('\t')).filter(parts => parts.length >= 2)
  const chosen = rows.find(parts => parts[0] === '1') ?? rows[0]
  const pane = chosen?.[1]?.trim()
  if (!pane || !/^%\d+$/.test(pane)) throw new PromptDeliveryError('worker pane not found')
  return pane
}

async function exitMode(tmux: Tmux, pane: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    let mode = '0'
    try {
      mode = (await tmux(['display-message', '-p', '-t', pane, '#{pane_in_mode}'])).trim()
    } catch {
      return
    }
    if (mode !== '1') return
    try { await tmux(['send-keys', '-t', pane, 'Escape']) } catch { /* overlay already gone */ }
    try { await tmux(['send-keys', '-X', 'cancel', '-t', pane]) } catch { /* not in a mode */ }
  }
  const mode = (await tmux(['display-message', '-p', '-t', pane, '#{pane_in_mode}'])).trim()
  if (mode === '1') throw new PromptDeliveryError('pane stayed in a mode, so the prompt was not typed')
}

export async function deliverKeys(target: string, keys: string[], opts?: { tmux?: Tmux }): Promise<void> {
  if (keys.length === 0 || keys.some(key => !COMPOSER_KEYS.has(key))) {
    throw new PromptDeliveryError('keys must be composer keys')
  }
  const tmux = opts?.tmux ?? defaultTmux
  return serialize(target, async () => {
    const pane = await activePane(tmux, target)
    await exitMode(tmux, pane)
    await tmux(['send-keys', '-t', pane, ...keys])
  })
}

export async function deliverPrompt(
  target: string,
  text: string,
  opts?: { tmux?: Tmux; settleMs?: number },
): Promise<void> {
  if (!text.trim()) throw new PromptDeliveryError('missing text')
  if (text.length > PROMPT_TEXT_LIMIT) throw new PromptDeliveryError('prompt is too long to paste into the pane')
  const tmux = opts?.tmux ?? defaultTmux
  const settleMs = opts?.settleMs ?? 300
  return serialize(target, async () => {
    const pane = await activePane(tmux, target)
    await exitMode(tmux, pane)
    const dir = mkdtempSync(join(tmpdir(), 'tinstar-prompt-'))
    const file = join(dir, 'prompt')
    const buffer = `tinstar-${randomUUID()}`
    let loaded = false
    try {
      writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
      await tmux(['load-buffer', '-b', buffer, file])
      loaded = true
      // -d removes the buffer after a successful paste. -p keeps the text
      // literal, so a prompt that starts with a tmux key name is not parsed.
      await tmux(['paste-buffer', '-d', '-r', '-p', '-b', buffer, '-t', pane])
      loaded = false
      // Enter in the same turn as the paste can submit before the text lands.
      if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
      await tmux(['send-keys', '-t', pane, '', 'Enter'])
    } finally {
      if (loaded) {
        try { await tmux(['delete-buffer', '-b', buffer]) } catch { /* already gone */ }
      }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })
}
