// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { NeedsYouPanel } from './NeedsYouPanel'
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('context panel defaults', () => {
  it('opens Needs You on overview and the worker switcher on a worker route', () => {
    expect(defaultPanelMode(null)).toBe('needs')
    expect(defaultPanelMode('alpha')).toBe('workers')
  })

  it('starts closed on a narrow window', () => {
    expect(initialPanelMode(null, false)).toBe('needs')
    expect(initialPanelMode('alpha', false)).toBe('workers')
    expect(initialPanelMode(null, true)).toBeNull()
    expect(initialPanelMode('alpha', true)).toBeNull()
  })
})

describe('cockpit shell', () => {
  it('switches panels without leaving the overview, then opens and collapses a worker', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/fleet/messages')) return Promise.resolve(json({ ok: true, data: [{
        requestId: 'tinstar-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', home: '/tmp/firstmate', taskId: 'alpha',
        decisionKey: null, kind: 'message', text: 'Hold the gate', state: 'sending', announced: false, reply: null, canReceive: true,
      }] }))
      if (url.includes('/api/quota')) return Promise.resolve(json({ checkedAt: null, fetchedAt: null, commandError: null, providers: [] }))
      if (url.includes('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers: [worker], attention: [decision], errors: [] } }))
      return Promise.resolve(json({ ok: false }, 404))
    })

    render(<App />)
    expect(await screen.findByText('Ship the shell?')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Needs You/ }).querySelector('.cockpit-activity-count')?.className).toContain('is-alert')
    expect((await screen.findByRole('button', { name: 'Messages, 1' })).querySelector('.cockpit-activity-count')?.className).toContain('is-alert')
    const workerCount = screen.getByRole('button', { name: /Workers/ }).querySelector('.cockpit-activity-count')
    expect(workerCount?.textContent).toBe('1')
    expect(workerCount?.className).toContain('is-quiet')
    expect(workerCount?.className).not.toContain('is-alert')
    expect(document.querySelector('.cockpit-context-title span')?.className ?? '').not.toContain('is-quiet')
    expect(document.querySelector('.cockpit-worker-button')).toBeNull()
    expect(window.location.search).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /Messages/ }))
    expect(screen.getByText('Hold the gate')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry sending' })).toBeTruthy()
    expect(screen.queryByText('Ship the shell?')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy()
    expect(window.location.search).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /Workers/ }))
    expect(document.querySelector('.cockpit-context-title span')?.className).toContain('is-quiet')
    const jump = screen.getByRole('textbox', { name: 'Jump to worker' })
    expect(jump).toBeTruthy()
    const alpha = document.querySelector('.cockpit-worker-button')
    expect(alpha).toBeTruthy()
    expect(screen.queryByText('Hold the gate')).toBeNull()

    fireEvent.click(alpha!)
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy()
    expect(document.querySelector('.cockpit-worker-button')?.className).toContain('active')
    expect(new URLSearchParams(window.location.search).get('worker')).toBe('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(screen.queryByRole('textbox', { name: 'Jump to worker' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('worker')).toBe('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(await screen.findByRole('heading', { name: 'Workers' })).toBeTruthy()
    expect(screen.getByText('Ship the shell?')).toBeTruthy()
    expect(document.querySelector('.cockpit-worker-button')).toBeNull()
  })

  it('opens a narrow window as a drawer and closes it from the backdrop or Escape', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('1099'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
    }))
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/fleet/messages')) return Promise.resolve(json({ ok: true, data: [] }))
      if (url.includes('/api/quota')) return Promise.resolve(json({ checkedAt: null, fetchedAt: null, commandError: null, providers: [] }))
      if (url.includes('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers: [worker], attention: [decision], errors: [] } }))
      return Promise.resolve(json({ ok: false }, 404))
    })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Workers' })).toBeTruthy()
    expect(screen.queryByText('Ship the shell?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('title')).toBe('Overview')

    fireEvent.click(screen.getByRole('button', { name: /Needs You/ }))
    expect(screen.getByText('Ship the shell?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss panel' }))
    expect(screen.queryByText('Ship the shell?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Needs You/ }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Ship the shell?')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy()
  })

  it('shows a receipt total as a quiet tally until a message needs a retry', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/fleet/messages')) return Promise.resolve(json({ ok: true, data: [{
        requestId: 'tinstar-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', home: '/tmp/firstmate', taskId: 'alpha',
        decisionKey: null, kind: 'message', text: 'Noted', state: 'acknowledged', announced: true, reply: null, canReceive: true,
      }] }))
      if (url.includes('/api/quota')) return Promise.resolve(json({ checkedAt: null, fetchedAt: null, commandError: null, providers: [] }))
      if (url.includes('/api/fleet')) return Promise.resolve(json({ ok: true, data: { ready: true, workers: [worker], attention: [], errors: [] } }))
      return Promise.resolve(json({ ok: false }, 404))
    })
    render(<App />)
    const messages = await screen.findByRole('button', { name: 'Messages, 1' })
    const tally = messages.querySelector('.cockpit-activity-count')
    expect(tally?.textContent).toBe('1')
    expect(tally?.className).toContain('is-quiet')
    expect(tally?.className).not.toContain('is-alert')
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
