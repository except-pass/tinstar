import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../../apiClient'
import { useDeskQueue } from '../useDeskQueue'
import { workflowSaved } from '../workflowSaved'
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
afterEach(() => vi.resetAllMocks())
it('refreshes after confirmed saves and ignores a late superseded read', async () => {
  let first!: (response: Response) => void
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { items: [], needsWill: [], generatedAt: 'new' } })))
  const view = renderHook(() => useDeskQueue())
  await act(async () => { workflowSaved() })
  await waitFor(() => expect(view.result.current.queue?.generatedAt).toBe('new'))
  await act(async () => first(new Response(JSON.stringify({ ok: true, data: { items: [], generatedAt: 'old' } }))))
  expect(view.result.current.queue?.generatedAt).toBe('new')
  expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ 'X-Tinstar-UI': '1' })
  view.unmount()
})
