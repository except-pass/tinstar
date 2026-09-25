import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerDescriptor } from '../../contract/descriptor'
import { blockedFixture } from '../../needsyou/fixtures'
import { displayName, hashPaletteColor, terminalDocumentSrc } from '../identity'
import { V6Shell } from '../V6Shell'

const alpha: WorkerDescriptor = {
  source: 'fm-fleet-snapshot',
  fixture: true,
  id: 'alpha',
  spawnGen: '1',
  project: 'tinstar',
  worktree: { path: '/tmp/alpha', present: true },
  backend: 'tmux',
  endpoint: { target: 'sess:alpha', exists: true, agentAlive: 'alive', status: 'alive' },
  crewState: 'working',
  observedAt: '2026-09-24T04:00:00Z',
}

const beta: WorkerDescriptor = {
  ...alpha,
  id: 'beta',
  crewState: 'parked',
  endpoint: { ...alpha.endpoint, target: 'sess:beta' },
}

function workersResponse(rows: WorkerDescriptor[], identities: Record<string, { color: string; alias?: string }> = {}) {
  return new Response(JSON.stringify({
    ok: true,
    data: { configured: true, workers: rows, identities, diagnostics: [] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('V6Shell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cycles with ctrl+brackets, keeps the draft, ignores the wheel, and jumps to the board', async () => {
    let rows = [beta, alpha]
    const fetches: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      fetches.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/api/v6/workers')) return workersResponse(rows, { alpha: { color: '#123456' } })
      if (url.includes('/api/v6/identity')) return new Response(JSON.stringify({ ok: true, data: { color: '#00f0ff' } }), { status: 200 })
      if (url.includes('/api/v6/intents') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: true,
          data: { disposition: 'queued', detail: 'queued', applied: false, requestId: 'req-1' },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/intents/')) {
        return new Response(JSON.stringify({ ok: true, data: { reply: null, applied: false } }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }))

    render(<V6Shell pollMs={60_000} />)
    expect(await screen.findByTestId('worker-alpha')).toHaveAttribute('data-color', '#123456')
    expect(screen.getAllByTestId('fixture-label').length).toBeGreaterThan(0)
    expect(screen.getByTestId('crew-alpha')).toHaveTextContent('working')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
    expect(hashPaletteColor('alpha')).not.toBe('#123456')

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'keep me' } })
    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(screen.getByLabelText('Message')).toHaveValue('')
    fireEvent.wheel(screen.getByTestId('v6-shell'), { deltaY: 120 })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true })
    expect(screen.getByLabelText('Message')).toHaveValue('keep me')

    const alphaFrame = document.createElement('iframe')
    alphaFrame.dataset.testid = 'terminal-alpha'
    fireEvent.click(screen.getByTestId('worker-next'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')

    fireEvent.click(screen.getByTestId('board'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'portfolio')
    expect(screen.getByText('No epics yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('back'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')

    rows = [alpha, beta]
    await waitFor(() => {
      expect(fetches.filter(line => line.startsWith('GET') && line.includes('/api/v6/workers')).length).toBeGreaterThan(0)
    })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(screen.queryByText(/autonomous supervision/i)).toBeNull()
    expect(alphaFrame).toBeTruthy()
  })

  it('shows queued, not applied, then the receipt reply on the same worker', async () => {
    let reply: { body: string; appliedOutcome: string | null } | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/workers')) return workersResponse([alpha])
      if (url.includes('/api/v6/identity')) {
        return new Response(JSON.stringify({ ok: true, data: { color: hashPaletteColor('alpha') } }), { status: 200 })
      }
      if (url.includes('/api/v6/intents') && init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { kind: string; anchor: { ids: string[] } }
        expect(sent.kind).toBe('thread.message')
        expect(sent.anchor.ids).toEqual(['alpha'])
        return new Response(JSON.stringify({
          ok: true,
          data: { disposition: 'queued', detail: 'queued', applied: false },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/intents/')) {
        return new Response(JSON.stringify({ ok: true, data: { reply, applied: reply?.appliedOutcome === 'applied' } }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }))

    render(<V6Shell pollMs={50} />)
    await screen.findByLabelText('Message')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello worker' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Not applied')).toBeInTheDocument()

    reply = { body: 'captain says hi', appliedOutcome: null }
    expect(await screen.findByTestId('intent-reply')).toHaveTextContent('captain says hi')
    expect(screen.getByText('Not applied')).toBeInTheDocument()
  })

  it('does not call a saved-unannounced note applied', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/workers')) return workersResponse([alpha])
      if (url.includes('/api/v6/identity')) return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
      if (url.includes('/api/v6/intents')) {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            ok: true,
            data: { disposition: 'saved-unannounced', detail: 'saved, not announced', applied: false },
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true, data: { reply: null } }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }))
    render(<V6Shell pollMs={60_000} />)
    await screen.findByLabelText('Message')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Saved, not announced')).toBeInTheDocument()
    expect(screen.getByText('Not applied')).toBeInTheDocument()
    expect(screen.queryByText(/^Applied$/)).toBeNull()
  })

  it('repeated bracket cycling does not restart a worker', async () => {
    const calls: { method: string; url: string; body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: String(init?.body ?? '') })
      if (url.includes('/terminal')) {
        return new Response(JSON.stringify({ ok: true, data: { state: 'live' } }), { status: 200 })
      }
      if (url.includes('/api/v6/workers')) {
        return workersResponse([alpha, beta], { alpha: { color: '#123456' }, beta: { color: '#abcdef' } })
      }
      return new Response('no', { status: 404 })
    }))

    const { container } = render(<V6Shell pollMs={60_000} />)
    const alphaRow = await screen.findByTestId('worker-alpha')
    const betaRow = screen.getByTestId('worker-beta')
    fireEvent.click(screen.getByTestId('open-terminal'))
    const frame = await screen.findByTestId('terminal-alpha')
    expect(frame).toHaveAttribute('src', terminalDocumentSrc('alpha', {
      name: 'alpha',
      color: '#123456',
      project: 'tinstar',
      worktree: '/tmp/alpha',
    }))
    expect(frame.getAttribute('src')).toContain('name=alpha')
    expect(frame.getAttribute('src')).toContain(`color=${encodeURIComponent('#123456')}`)

    const seen: string[] = []
    function cycle(target: Window | HTMLElement, code: 'BracketLeft' | 'BracketRight') {
      fireEvent.keyDown(target, { code, ctrlKey: true })
      seen.push(screen.getByTestId('v6-shell').getAttribute('data-worker') ?? '')
    }
    const message = () => screen.getByLabelText('Message')
    cycle(window, 'BracketRight')
    cycle(message(), 'BracketRight')
    cycle(frame, 'BracketLeft')
    cycle(frame, 'BracketRight')
    cycle(window, 'BracketRight')
    cycle(message(), 'BracketLeft')
    cycle(window, 'BracketRight')
    cycle(frame, 'BracketLeft')

    expect(seen).toEqual(['beta', 'alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta', 'alpha'])
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
    expect(container.querySelector('[data-testid="terminal-alpha"]')).toBe(frame)
    expect(screen.getByTestId('worker-alpha')).toBe(alphaRow)
    expect(screen.getByTestId('worker-beta')).toBe(betaRow)
    expect(screen.queryByTestId('open-terminal')).toBeNull()

    const terminalCalls = calls.filter(call => call.url.includes('/terminal'))
    expect(terminalCalls).toEqual([{
      method: 'POST',
      url: '/api/v6/workers/alpha/terminal',
      body: JSON.stringify({ spawnGen: '1', target: 'sess:alpha' }),
    }])
    expect(calls.some(call => /restart|spawn|fm-spawn|\/launch|kill/i.test(`${call.method} ${call.url}`))).toBe(false)
  })

  it('keeps one worker name, face, and color across the shell surfaces a refresh paints', async () => {
    const alphaName = displayName('alpha', 'Ace')
    const betaName = displayName('beta', 'Bee')
    let polls = 0
    const identityPosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/identity') && init?.method === 'POST') {
        identityPosts.push(String(init.body ?? ''))
        return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
      }
      if (url.includes('/api/v6/workers')) {
        polls += 1
        const rows = polls === 1 ? [alpha, beta] : [beta, alpha]
        return workersResponse(rows, {
          alpha: { color: '#123456', alias: 'Ace' },
          beta: { color: '#abcdef', alias: 'Bee' },
        })
      }
      return new Response('no', { status: 404 })
    }))

    render(<V6Shell pollMs={200} />)
    const alphaRow = await screen.findByTestId('worker-alpha')
    expect(alphaRow).toHaveAttribute('data-color', '#123456')
    expect(hashPaletteColor('alpha')).not.toBe('#123456')
    expect(hashPaletteColor('beta')).not.toBe('#abcdef')

    function faceSignature(scope: ParentNode): string {
      const mark = scope.querySelector('img, span[aria-hidden="true"]')
      if (!(mark instanceof HTMLElement)) throw new Error('missing face')
      if (mark.tagName === 'IMG') return `img:${mark.getAttribute('src')}`
      return `mark:${mark.style.borderColor}`
    }
    function headerFaceScope(): HTMLElement {
      const heading = screen.getByRole('heading', { level: 1, name: alphaName })
      const scope = heading.parentElement?.parentElement
      if (!scope) throw new Error('missing worker header')
      return scope
    }

    const before = {
      railName: alphaName,
      headerName: screen.getByRole('heading', { level: 1, name: alphaName }).textContent,
      color: alphaRow.getAttribute('data-color'),
      railFace: faceSignature(alphaRow),
      headerFace: faceSignature(headerFaceScope()),
      betaColor: screen.getByTestId('worker-beta').getAttribute('data-color'),
      betaFace: faceSignature(screen.getByTestId('worker-beta')),
    }
    expect(before.headerName).toBe(alphaName)
    expect(alphaRow).toHaveTextContent(alphaName)
    expect(screen.getByTestId('worker-beta')).toHaveTextContent(betaName)
    expect(before.railFace).toBe(before.headerFace)
    expect(before.betaFace).not.toBe(before.railFace)

    await waitFor(() => {
      expect(polls).toBeGreaterThan(1)
    })
    const alphaAfter = screen.getByTestId('worker-alpha')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
    expect(screen.getByRole('heading', { level: 1, name: alphaName })).toBeInTheDocument()
    expect(alphaAfter).toHaveAttribute('data-color', before.color)
    expect(alphaAfter).toHaveTextContent(alphaName)
    expect(faceSignature(alphaAfter)).toBe(before.railFace)
    expect(faceSignature(headerFaceScope())).toBe(before.headerFace)
    expect(screen.getByTestId('worker-beta')).toHaveAttribute('data-color', before.betaColor)
    expect(screen.getByTestId('worker-beta')).toHaveTextContent(betaName)
    expect(faceSignature(screen.getByTestId('worker-beta'))).toBe(before.betaFace)
    expect(headerFaceScope().querySelector<HTMLElement>('img, span[aria-hidden="true"]')?.style.borderColor).toBe(alphaAfter.style.borderColor)
    expect(identityPosts).toEqual([])
  })

  it('shows that same name, face, and color on the task, attention provenance, and terminal document', async () => {
    let polls = 0
    const identityPosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/identity') && init?.method === 'POST') {
        identityPosts.push(String(init.body ?? ''))
        return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
      }
      if (url.includes('/terminal')) {
        return new Response(JSON.stringify({ ok: true, data: { state: 'live' } }), { status: 200 })
      }
      if (url.includes('/api/v6/workers')) {
        polls += 1
        return workersResponse([alpha], { alpha: { color: '#123456', alias: 'Ace' } })
      }
      if (url.includes('/api/v6/needsyou')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            items: [blockedFixture({ id: 'ny-alpha', provenance: { workerId: 'alpha', taskId: 'task-1' } })],
          },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/objectives/')) {
        return new Response(JSON.stringify({ ok: true, data: { workerId: 'alpha', current: null, history: [] } }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }))

    const view = render(<V6Shell pollMs={200} />)
    const rail = await screen.findByTestId('worker-alpha')
    const task = await screen.findByTestId('objective-identity')
    const attention = await screen.findByTestId('needsyou-provenance-ny-alpha')

    function faceOf(scope: HTMLElement): HTMLElement {
      const face = scope.querySelector<HTMLElement>('[data-face="alpha"]')
      expect(face).toBeTruthy()
      return face!
    }

    expect(rail).toHaveAttribute('data-color', '#123456')
    expect(rail).toHaveAttribute('data-name', 'Ace')
    expect(rail).toHaveTextContent('Ace')
    expect(hashPaletteColor('alpha')).not.toBe('#123456')
    expect(task).toHaveAttribute('data-name', 'Ace')
    expect(task).toHaveAttribute('data-color', rail.getAttribute('data-color'))
    expect(task).toHaveTextContent('Ace')
    expect(attention).toHaveAttribute('data-name', 'Ace')
    expect(attention).toHaveAttribute('data-color', '#123456')
    expect(attention).toHaveTextContent('Ace')
    expect(faceOf(task).style.borderColor).toBe(faceOf(rail).style.borderColor)
    expect(faceOf(attention).style.borderColor).toBe(faceOf(rail).style.borderColor)

    await waitFor(() => expect(polls).toBeGreaterThan(1))
    expect(screen.getByTestId('objective-identity')).toHaveAttribute('data-color', '#123456')
    expect(screen.getByTestId('objective-identity')).toHaveAttribute('data-name', 'Ace')
    expect(screen.getByTestId('objective-identity').querySelector('[data-face="alpha"]')).toBeTruthy()
    expect(screen.getByTestId('needsyou-provenance-ny-alpha')).toHaveAttribute('data-color', '#123456')
    expect(screen.getByTestId('needsyou-provenance-ny-alpha')).toHaveAttribute('data-name', 'Ace')
    expect(screen.getByTestId('needsyou-provenance-ny-alpha').querySelector('[data-face="alpha"]')).toBeTruthy()
    expect(identityPosts).toEqual([])

    fireEvent.click(screen.getByTestId('open-terminal'))
    const frame = await screen.findByTestId('terminal-alpha')
    const src = frame.getAttribute('src') ?? ''
    expect(src).toContain('name=Ace')
    expect(src).toContain(`color=${encodeURIComponent('#123456')}`)
    const faceUrl = 'data:image/svg+xml;base64,QQ=='
    view.unmount()

    vi.useFakeTimers()
    try {
      const wrapper = readFileSync(join(process.cwd(), 'public', 'v6-terminal-wrapper.html'), 'utf8')
      const body = wrapper.match(/<body>([\s\S]*?)<script>/)?.[1]
      const script = wrapper.match(/<script>([\s\S]*?)<\/script>/)?.[1]
      expect(body).toBeTruthy()
      expect(script).toBeTruthy()
      const search = src.slice(src.indexOf('?'))
      window.history.replaceState({}, '', `/v6-terminal-wrapper.html${search}`)
      document.body.innerHTML = body!
      new Function(script!)()
      const bar = document.getElementById('worker-identity')
      const paintedFace = document.getElementById('worker-face')
      expect(bar?.getAttribute('data-name')).toBe('Ace')
      expect(bar?.getAttribute('data-color')).toBe('#123456')
      expect(bar?.textContent).toContain('Ace')
      expect(paintedFace?.getAttribute('data-face')).toBe('alpha')
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'v6-worker-identity',
          worker: 'alpha',
          name: 'Ace',
          color: '#123456',
          face: faceUrl,
          project: 'tinstar',
          worktree: '/tmp/alpha',
        },
      }))
      expect(document.getElementById('worker-name')?.textContent).toBe('Ace')
      expect(document.getElementById('worker-identity')?.getAttribute('data-color')).toBe('#123456')
      expect(document.getElementById('worker-face')?.getAttribute('src')).toBe(faceUrl)
      expect(document.getElementById('worker-face')?.getAttribute('data-face')).toBe('alpha')
    } finally {
      vi.useRealTimers()
      document.body.innerHTML = ''
    }
  })
})
