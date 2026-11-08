// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActionControls } from '../ActionControls'
import { actionExamples } from '../../server/actions/examples'
import { installed, snapshot } from '../../server/actions/__tests__/fixtures'
const ask = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../ask/Ask', () => ({ useAskControls: () => ask, AskCardAction: () => <button>Ask receipt</button> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })
it('inspects exact source/grants/tests, installs only by explicit owner click and routes creation through shared Ask', async () => {
  const catalog = { installed: [], examples: actionExamples(), receipts: [], policy: { unknownReason: 'Partial inventory' }, runner: 'Custom execution unavailable' }
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: init?.method === 'POST' ? {} : catalog })))
  vi.stubGlobal('fetch', fetch)
  render(<ActionControls targets={[snapshot()]} view={{ scene: 'pulls' }} />)
  fireEvent.click(screen.getByText('Inspect / install actions'))
  fireEvent.click(await screen.findByText('Inspect Explain candidate'))
  expect(screen.getByText(/export default async/)).toBeTruthy()
  const install = screen.getByRole('button', { name: 'Install inspected version locally' })
  expect(install).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(install)
  await waitFor(() => expect(fetch.mock.calls.some(([path, init]) => path === '/api/actions/install' && init?.method === 'POST')).toBe(true))
  const sent = fetch.mock.calls.find(([path]) => path === '/api/actions/install')![1]!
  expect(JSON.parse(String(sent.body))).toMatchObject({ inspected: true, candidate: { manifest: { id: 'explain' } } })
  expect(sent.headers).toMatchObject({ 'X-Tinstar-UI': '1' })
  fireEvent.click(screen.getByText('Make a button…'))
  expect(ask.open).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: 'pull', id: snapshot().id }), field_value: expect.stringContaining('Make a button') }))
})
it('disables Admin Merge when inventory is incomplete and on merged PRs, but allows read actions in Releases', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, data: { installed: [installed(), installed('explain')], examples: [], receipts: [], policy: { unknownReason: 'Exact checks incomplete' }, runner: '' } })))
  render(<ActionControls targets={[{ ...snapshot(), state: 'merged' }]} view={{ scene: 'releases' }} />)
  const merge = await screen.findByRole('button', { name: 'Admin Merge · Simulated' })
  expect(merge).toBeDisabled()
  expect(merge.title).toContain('merged or closed')
  expect(screen.getByRole('button', { name: 'Explain · Simulated' })).not.toBeDisabled()
  cleanup()
  render(<ActionControls targets={[snapshot()]} view={{ scene: 'pulls' }} />)
  expect(await screen.findByRole('button', { name: 'Admin Merge · Simulated' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Admin Merge · Simulated' }).title).toBe('Exact checks incomplete')
})
it('invokes exact installed version/captured head, exposes coordinated mode and has no automatic Ask-triggered effect', async () => {
  const action = installed('fix-ci'), catalog = { installed: [action], examples: [], receipts: [], policy: { unknownReason: 'Incomplete' }, runner: '' }
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: init?.method === 'POST' ? { runId: 'run' } : catalog })))
  vi.stubGlobal('fetch', fetch)
  render(<ActionControls targets={[snapshot(), snapshot(2)]} view={{ scene: 'releases' }} />)
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'coordinated' } })
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Fix CI · Simulated' }))
  await waitFor(() => expect(fetch.mock.calls.some(([path]) => path === '/api/actions/run')).toBe(true))
  const payload = JSON.parse(String(fetch.mock.calls.find(([path]) => path === '/api/actions/run')![1]!.body))
  expect(payload).toMatchObject({ action: 'fix-ci', version: 'v1', mode: 'coordinated', view: { scene: 'releases' }, targets: [{ head: snapshot().head, base: 'main' }, { head: snapshot().head, base: 'main' }] })
})
