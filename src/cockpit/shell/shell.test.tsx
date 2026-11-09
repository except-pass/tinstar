// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { NeedsYouPanel } from './NeedsYouPanel'
import { WorkerSwitcherPanel } from './WorkerSwitcherPanel'
import { defaultPanelMode, initialPanelMode, type AttentionCard, type Worker } from './types'

const worker: Worker = {
  key: 'cockpit-0-alpha', id: 'alpha', home: '/tmp/firstmate', kind: 'worker', state: 'working',
  detail: 'busy', observedAt: null, freshness: 'fresh', objective: 'Hold the line', project: '/tmp/alpha',
  direct: false, worktree: '/tmp/alpha', branch: 'fm/alpha', prUrl: null, terminalAvailable: false, terminalPid: null,
}

const decision: AttentionCard = {
  key: 'need-1', homeIndex: 0, home: '/tmp/firstmate', taskId: 'alpha', decisionKey: 'go', holdId: null,
  dismissal: null, type: 'decision', headline: 'Ship the shell?', detail: 'Needs a yes.', workerKey: worker.key,
  workerId: 'alpha', ageDays: 0, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function panelOpen(): boolean {
  return !document.querySelector<HTMLElement>('.cockpit-context')!.hidden
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

function fleetStub() {
  const bravo: Worker = { ...worker, key: 'cockpit-0-bravo', id: 'bravo' }
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input)
    if (url.includes('/api/fleet/messages')) return Promise.resolve(json({ ok: true, data: [{ requestId: 'receipt', home: worker.home, taskId: 'alpha', decisionKey: null, kind: 'message', text: 'Noted', state: 'acknowledged', announced: true, reply: null, canReceive: true }] }))
    if (url.includes('/api/quota')) return Promise.resolve(json({ checkedAt: null, fetchedAt: null, commandError: null, providers: [] }))
    if (url.includes('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers: [worker, bravo], attention: [decision], errors: [] } }))
    return Promise.resolve(json({ ok: false }, 404))
  })
}

// Rendering App beside another suite exceeds the 5s default.
describe('Overview shell and retained terminal navigation', () => {
  it('starts with one Overview and no legacy queue or Floor destination', async () => {
    fleetStub()
    render(<App />)
    expect(await screen.findByRole('region', { name: 'Overview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Needs You|Floor/ })).toBeNull()
    const rail = screen.getByRole('navigation', { name: 'Activity' })
    expect(rail.textContent).toContain('PRs')
    expect(rail.textContent).toContain('Releases')
    expect(rail.textContent).not.toMatch(/Receipts|Workers/)
    expect(panelOpen()).toBe(false)
    expect(defaultPanelMode(null)).toBeNull()
    expect(initialPanelMode('alpha', false)).toBeNull()
    expect(initialPanelMode(null, true)).toBeNull()
  })
  it('never mounts response controls for a ready Desk request', async () => {
    const queue = fixtureQueue(), item = queue.items[0]!
    item.decisionKeys = ['go']
    item.sources = [{ kind: 'firstmate', id: JSON.stringify([worker.home, worker.id]), field: 'hints.open_decisions:go',
      request: { home: worker.home, taskId: worker.id, id: 'go', kind: 'decision' },
      observedAt: new Date().toISOString(), expiresAt: null, status: 'fresh', coverage: 'complete' }]
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/api/reconciliation/scene')) return Promise.resolve(json({ ok: true, data: fixtureScene() }))
      if (url.endsWith('/api/reconciliation/queue')) return Promise.resolve(json({ ok: true, data: queue }))
      if (url.endsWith('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers: [worker], attention: [decision], errors: [] } }))
      if (url.endsWith('/api/fleet/messages')) return Promise.resolve(json({ ok: true, data: [] }))
      return Promise.resolve(json({ ok: false }, 404))
    })
    const { container } = render(<App />)
    expect(screen.queryByRole('button', { name: 'Find worker' })).toBeNull()
    await screen.findByLabelText('Request inspector')
    expect(container.querySelector('.cockpit-attention-card')).toBeNull()
    expect(screen.queryByText('Respond through First Mate')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Answer this decision' })).toBeNull()
  })
  it('retains worker cycling and a closed panel on return to Overview without retired receipt navigation', async () => {
    window.history.replaceState(null, '', '/?worker=alpha&home=firstmate')
    fleetStub()
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy()
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Switch worker' }))
    expect(screen.getByRole('textbox', { name: 'Jump to worker' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', ctrlKey: true })
    expect(await screen.findByRole('heading', { name: 'bravo' })).toBeTruthy()
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(await screen.findByRole('region', { name: 'Overview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Message receipts' })).toBeNull()
    expect(screen.queryByText('Noted')).toBeNull()
    expect(panelOpen()).toBe(false)
  })
  it('recovers worker notes with the original request and shows their replies', async () => {
    window.history.replaceState(null, '', '/?worker=alpha&home=firstmate')
    const note = { requestId: 'note-id', home: worker.home, taskId: worker.id, decisionKey: null, kind: 'message', text: 'Check deployment', state: 'saved', announced: false, reply: null as string | null, canReceive: true }
    const posts: unknown[] = []
    vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/fleet/messages')) {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)))
          note.state = 'acknowledged'; note.announced = true; note.reply = 'Deployment checked'
          return Promise.resolve(json({ ok: true, data: { saved: true, error: null, canReceive: true } }))
        }
        return Promise.resolve(json({ ok: true, data: [note, { ...note, requestId: 'other', home: '/other', text: 'Other home note' }] }))
      }
      if (url.endsWith('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers: [worker], attention: [], errors: [] } }))
      return Promise.resolve(json({ ok: false }, 404))
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByText('Tell First Mate about this', { selector: 'summary' }))
    expect(await screen.findByText('Check deployment', { selector: 'p' })).toBeTruthy()
    expect(within(screen.getByText('Tell First Mate about this', { selector: 'summary' }).parentElement!).queryByText('Other home note', { selector: 'p' })).toBeNull()
    fireEvent.click(within(screen.getByText('Tell First Mate about this', { selector: 'summary' }).parentElement!).getByText('Delivery details', { selector: 'summary' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' })) })
    expect(posts).toEqual([{ requestId: 'note-id', kind: 'message', text: 'Check deployment' }])
    expect(await screen.findByText('Deployment checked', { selector: 'p' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull()
  })
  it('keeps retained notes recoverable after their worker disappears and navigation', async () => {
    window.history.replaceState(null, '', '/?worker=alpha&home=firstmate')
    let workers = [worker]
    const note = { requestId: 'retained-id', home: worker.home, taskId: worker.id, decisionKey: null, kind: 'message', text: 'Retained deployment note', state: 'saved', announced: false, reply: null as string | null, canReceive: true }
    const posts: unknown[] = []
    const polls: (() => void)[] = []
    const timer = vi.spyOn(window, 'setInterval').mockImplementation(handler => {
      if (typeof handler === 'function') polls.push(handler as () => void)
      return 1
    })
    vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/fleet/messages')) {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)))
          note.state = 'acknowledged'; note.announced = true; note.reply = 'Retained reply'
          return Promise.resolve(json({ ok: true, data: { saved: true, error: null, canReceive: true } }))
        }
        return Promise.resolve(json({ ok: true, data: [note] }))
      }
      if (url.endsWith('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers, attention: [], errors: [] } }))
      return Promise.resolve(json({ ok: false }, 404))
    })
    try {
      render(<App />)
      await screen.findByRole('heading', { name: 'alpha' })
      workers = []
      await act(async () => { polls.forEach(poll => poll()) })
      expect(await screen.findByRole('heading', { name: 'No such worker' })).toBeTruthy()
      fireEvent.click(screen.getByText('Retained worker notes · 1'))
      expect(screen.getAllByText('Retained deployment note', { selector: 'p' })).toHaveLength(1)
      fireEvent.click(screen.getByText('Delivery details', { selector: 'summary' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' })) })
      expect(posts).toEqual([{ requestId: 'retained-id', kind: 'message', text: 'Retained deployment note' }])
      expect(await screen.findByText('Retained reply', { selector: 'p' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
      expect(await screen.findByText('Retained reply', { selector: 'p' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Message receipts' })).toBeNull()
    } finally { timer.mockRestore() }
  })
  it('closes a narrow worker drawer after selection and Escape', async () => {
    window.history.replaceState(null, '', '/?worker=alpha&home=firstmate')
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1099'), media: query, addEventListener() {}, removeEventListener() {} }))
    fleetStub()
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Switch worker' }))
    fireEvent.click(document.querySelector('.cockpit-worker-button')!)
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Switch worker' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panelOpen()).toBe(false)
    act(() => { window.history.replaceState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(await screen.findByRole('region', { name: 'Overview' })).toBeTruthy()
  })
}, 30_000)

describe('worker switcher', () => {
  it('opens the first shown row on Enter', () => {
    const kd: Worker = { ...worker, key: 'cockpit-0-kd', id: 'kd', project: '/tmp/tinstar' }
    const docs: Worker = { ...worker, key: 'cockpit-0-docs', id: 'tinstar-docs', project: '/tmp/docs' }
    const onOpen = vi.fn()
    const onQuery = vi.fn()
    render(<WorkerSwitcherPanel workers={[kd, docs]} currentKey={null} query="tinstar" onQuery={onQuery} onOpen={onOpen} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Jump to worker' }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('cockpit-0-kd')
    expect(onQuery).toHaveBeenCalledWith('')
  })
})

describe('Needs You actions', () => {
  it('sends an answer and still offers Tell First Mate', async () => {
    const submit = vi.fn(() => Promise.resolve({ saved: true, error: null, canReceive: true }))
    const onOpen = vi.fn()
    render(<NeedsYouPanel cards={[decision]} workers={[worker]} errors={[]} waiting={false} submit={submit} dismissing={() => false} dismissed={() => false} dismissError={() => null} onOpen={onOpen} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByText('Answer'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer this decision' }), { target: { value: 'yes' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to First Mate' }))
    })
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'answer', text: 'yes', anchorKey: 'need-1' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Tell First Mate about this' })[0]!)
    expect(onOpen).toHaveBeenCalledWith(decision)
  })
})
