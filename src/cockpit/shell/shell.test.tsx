// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { NeedsYouPanel } from './NeedsYouPanel'
import { defaultPanelMode, type AttentionCard, type Worker } from './types'

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
    expect(document.querySelector('.cockpit-worker-button')).toBeNull()
    expect(window.location.search).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /Messages/ }))
    expect(screen.getByText('Hold the gate')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry sending' })).toBeTruthy()
    expect(screen.queryByText('Ship the shell?')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy()
    expect(window.location.search).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /Workers/ }))
    const jump = screen.getByRole('textbox', { name: 'Jump to worker' })
    expect(jump).toBeTruthy()
    const alpha = document.querySelector('.cockpit-worker-button')
    expect(alpha).toBeTruthy()
    expect(screen.queryByText('Hold the gate')).toBeNull()

    fireEvent.click(alpha!)
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy()
    expect(document.querySelector('.cockpit-worker-button')?.className).toContain('active')
    expect(new URLSearchParams(window.location.search).get('worker')).toBe('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }))
    expect(screen.queryByRole('textbox', { name: 'Jump to worker' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('worker')).toBe('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(await screen.findByRole('heading', { name: 'Workers' })).toBeTruthy()
    expect(screen.getByText('Ship the shell?')).toBeTruthy()
    expect(document.querySelector('.cockpit-worker-button')).toBeNull()
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
