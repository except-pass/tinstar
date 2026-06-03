import { apiFetch } from '../../apiClient'
import type { TerminalHandle } from '@tinstar/plugin-api'

async function envelope<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data?: T; error?: { message?: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'request failed')
  return body.data as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

/** Build the imperative TerminalHandle methods for a session. Pure over apiFetch
 *  so it's unit-testable; `focus` is supplied by the widget (DOM-dependent). */
export function makeTerminalHandle(
  sessionId: string,
  focus: () => void = () => {},
): TerminalHandle {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`
  return {
    sessionId,
    focus,
    async sendKeys(keys) { await envelope(await apiFetch(`${base}/send-keys`, json('POST', { keys }))) },
    async sendText(text, opts) {
      if (opts?.enter === false) { await envelope(await apiFetch(`${base}/send-keys`, json('POST', { keys: [text] }))); return }
      await envelope(await apiFetch(`${base}/enter-prompt`, json('POST', { prompt: text })))
    },
    async readScreen(opts) {
      const q = opts?.scrollback ? `?scrollback=${opts.scrollback}` : ''
      const d = await envelope<{ screen: string }>(await apiFetch(`${base}/screen${q}`, json('GET')))
      return d.screen
    },
    async exec(argv) { return envelope(await apiFetch(`${base}/exec`, json('POST', { argv }))) },
  }
}
