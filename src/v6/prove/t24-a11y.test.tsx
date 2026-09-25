import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerDescriptor } from '../contract/descriptor'
import { V6Shell } from '../shell/V6Shell'

const motionCss = readFileSync(join(process.cwd(), 'src/v6/shell/motion.css'), 'utf8')

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

const beta: WorkerDescriptor = { ...alpha, id: 'beta', endpoint: { ...alpha.endpoint, target: 'sess:beta' } }
const gamma: WorkerDescriptor = { ...alpha, id: 'gamma', endpoint: { ...alpha.endpoint, target: 'sess:gamma' } }

function workersResponse(rows: WorkerDescriptor[]) {
  return new Response(JSON.stringify({
    ok: true,
    data: { configured: true, workers: rows, identities: {}, diagnostics: [] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function json(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function installFetch(options: { terminal?: 'live' | 'down' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/v6/workers/') && url.includes('/terminal')) {
      if (init?.method === 'DELETE') return json({})
      if (options.terminal === 'down') return json({ state: 'unavailable', reason: 'endpoint changed' })
      return json({ state: 'live' })
    }
    if (url.includes('/api/v6/workers')) return workersResponse([alpha, beta, gamma])
    if (url.includes('/api/v6/identity')) return json({})
    return new Response('no', { status: 404 })
  }))
}

function installMotion(matches: boolean) {
  let current = matches
  const listeners = new Set<() => void>()
  const media = {
    get matches() { return current },
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, cb: () => void) => { listeners.add(cb) },
    removeEventListener: (_type: string, cb: () => void) => { listeners.delete(cb) },
    addListener: (cb: () => void) => { listeners.add(cb) },
    removeListener: (cb: () => void) => { listeners.delete(cb) },
    dispatchEvent: () => false,
  }
  vi.stubGlobal('matchMedia', () => media)
  return {
    set(next: boolean) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

async function renderShell(options: { terminal?: 'live' | 'down'; reduce?: boolean } = {}) {
  installFetch(options)
  const motion = installMotion(options.reduce === true)
  render(<V6Shell pollMs={60_000} />)
  expect(await screen.findByTestId('worker-alpha')).toBeInTheDocument()
  expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
  return motion
}

describe('T24 motion and focus', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('applies direct jumps and rapid switches before the arrival animation can finish', async () => {
    await renderShell()
    const shell = screen.getByTestId('v6-shell')
    const stage = screen.getByTestId('v6-stage')
    expect(stage.classList.contains('v6-arrive')).toBe(true)

    const views: string[] = []
    const viewObs = new MutationObserver(() => { views.push(shell.getAttribute('data-view') ?? '') })
    viewObs.observe(shell, { attributes: true, attributeFilter: ['data-view'] })
    const jumpStart = performance.now()
    fireEvent.click(screen.getByTestId('board'))
    expect(performance.now() - jumpStart).toBeLessThan(160)
    expect(shell).toHaveAttribute('data-view', 'portfolio')
    await Promise.resolve()
    expect(views).toEqual(['portfolio'])
    expect(views).not.toContain('epic')
    expect(views).not.toContain('task')
    viewObs.disconnect()

    fireEvent.click(screen.getByTestId('worker-alpha'))
    expect(shell).toHaveAttribute('data-view', 'worker')
    expect(shell).toHaveAttribute('data-worker', 'alpha')

    const seen: string[] = []
    const burstStart = performance.now()
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
      seen.push(shell.getAttribute('data-worker') ?? '')
    }
    expect(performance.now() - burstStart).toBeLessThan(160 * 6)
    expect(seen).toEqual(['beta', 'gamma', 'alpha', 'beta', 'gamma', 'alpha'])
    expect(shell).toHaveAttribute('data-worker', 'alpha')
    expect(shell).toHaveAttribute('data-switch-seq', '8')
    expect(stage.classList.contains('v6-arrive')).toBe(true)
  })

  it('drops the arrival motion when reduced motion is on, including a live change', async () => {
    const reduced = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('animation: none !important')
    expect(reduced).toContain('transition: none !important')
    expect(motionCss).toContain('animation: v6-arrive 160ms ease-out')

    const motion = await renderShell({ reduce: true })
    const shell = screen.getByTestId('v6-shell')
    const stage = screen.getByTestId('v6-stage')
    expect(shell).toHaveAttribute('data-reduced', 'true')
    expect(stage.classList.contains('v6-arrive')).toBe(false)
    expect(screen.getByTestId('worker-alpha').className).not.toContain('duration-150')

    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
    expect(shell).toHaveAttribute('data-worker', 'beta')
    expect(stage.classList.contains('v6-arrive')).toBe(false)

    act(() => { motion.set(false) })
    expect(shell).toHaveAttribute('data-reduced', 'false')
    expect(stage.classList.contains('v6-arrive')).toBe(true)

    act(() => { motion.set(true) })
    expect(shell).toHaveAttribute('data-reduced', 'true')
    expect(stage.classList.contains('v6-arrive')).toBe(false)
    expect(screen.getByTestId('worker-beta').className).not.toContain('duration-150')
  })

  it('returns focus after the terminal dialog closes and still cycles', async () => {
    await renderShell({ terminal: 'down' })
    const opener = screen.getByTestId('open-terminal')
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByTestId('v6-terminal-dialog')
    expect(dialog).toHaveAttribute('open')
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByTestId('v6-terminal-dialog')).toBeNull()
    expect(opener).toHaveFocus()

    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
  })

  it('keeps focus in the shell across a view change and a closed terminal', async () => {
    await renderShell()
    const message = screen.getByLabelText('Message')
    message.focus()
    fireEvent.click(screen.getByTestId('board'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'portfolio')
    expect(screen.getByRole('heading', { name: 'Portfolio' })).toHaveFocus()
    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
    const shell = screen.getByTestId('v6-shell')
    expect(shell).toHaveAttribute('data-view', 'worker')
    expect(shell).toHaveAttribute('data-worker', 'beta')

    const board = screen.getByTestId('board')
    board.focus()
    fireEvent.click(board)
    expect(shell).toHaveAttribute('data-view', 'portfolio')
    expect(board).toHaveFocus()
    fireEvent.click(screen.getByTestId('back'))
    expect(shell).toHaveAttribute('data-view', 'worker')

    fireEvent.click(screen.getByTestId('open-terminal'))
    expect(await screen.findByTestId('terminal-beta')).toBeTruthy()
    const closeView = screen.getByRole('button', { name: 'Close view' })
    closeView.focus()
    fireEvent.click(closeView)
    expect(screen.queryByTestId('terminal-beta')).toBeNull()
    expect(screen.getByTestId('open-terminal')).toHaveFocus()
    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true })
    expect(shell).toHaveAttribute('data-worker', 'alpha')
  })

  it('accepts terminal bracket messages immediately and moves focus off a hidden frame', async () => {
    await renderShell({ terminal: 'live' })
    fireEvent.click(screen.getByTestId('open-terminal'))
    const frame = await screen.findByTestId('terminal-alpha')
    frame.focus()
    const shell = screen.getByTestId('v6-shell')
    const start = performance.now()
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'v6-worker-cycle', direction: 'next' } }))
    })
    expect(performance.now() - start).toBeLessThan(160)
    expect(shell).toHaveAttribute('data-worker', 'beta')
    expect(shell).toHaveAttribute('data-view', 'worker')
    expect(frame).toHaveStyle({ visibility: 'hidden' })
    expect(screen.getByTestId('open-terminal')).toHaveFocus()

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'v6-worker-cycle', direction: 'next' } }))
    })
    expect(shell).toHaveAttribute('data-worker', 'gamma')
    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true, metaKey: false })
    expect(shell).toHaveAttribute('data-worker', 'beta')
  })
})
