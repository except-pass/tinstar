// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost:5273/terminal-wrapper.html" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WRAPPER = readFileSync(
  join(process.cwd(), 'public', 'terminal-wrapper.html'),
  'utf8',
)

/**
 * Run the wrapper's inline script against a given query string.
 *
 * The wrapper is a standalone HTML file with no module boundary, so the only
 * honest way to assert what it points the iframe at is to execute it. A source
 * grep would pass just as happily against a branch that had merely moved.
 */
function loadWrapper(search: string): HTMLIFrameElement {
  const body = WRAPPER.match(/<body>([\s\S]*?)<script>/)![1]!
  const script = WRAPPER.match(/<script>([\s\S]*?)<\/script>/)![1]!
  window.history.replaceState({}, '', `/terminal-wrapper.html${search}`)
  document.body.innerHTML = body
  new Function(script)()
  return document.getElementById('term') as HTMLIFrameElement
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('terminal-wrapper — every terminal goes through the session proxy', () => {
  it('renders the proxied path for a session', () => {
    const frame = loadWrapper('?session=run-1')
    expect(frame.src).toContain('/s/run-1/')
  })

  it('does not build a host-and-port URL when given only a port', () => {
    // A loopback-only terminal port is not reachable from a remote browser at
    // all, so deriving a host can never work — the proxy is the only path.
    const frame = loadWrapper('?port=7681')
    expect(frame.getAttribute('src') ?? '').not.toContain('7681')
    expect(frame.getAttribute('src') ?? '').not.toMatch(/^https?:\/\/[^/]+:\d+/)
  })

  it('surfaces an error rather than a bare-port URL when the session is empty', () => {
    // The composer emits `session=` for an unresolved session id; an empty
    // string is falsy, which is exactly how the bare-port branch used to be
    // reached without anyone asking for it.
    loadWrapper('?session=&port=7681')
    const overlay = document.getElementById('error-overlay')!
    expect(overlay.classList.contains('visible')).toBe(true)
    expect(document.getElementById('error-msg')!.textContent)
      .toMatch(/session/i)
  })
})
