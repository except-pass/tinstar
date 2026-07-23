// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri). Mock it so
// the compose POST is observable and the delivered path is deterministic.
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { SlateComposer } from '../SlateComposer'

function okDelivered(delivered = true) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { delivered } }) } as unknown as Response)
}

describe('SlateComposer (U4)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  it("typing 'pr' fuzzy-filters the catalog to PR review first", () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-search'), { target: { value: 'pr' } })
    const first = screen
      .getByTestId('composer-templates')
      .querySelector('[data-testid^="composer-template-"]')
    expect(first?.getAttribute('data-testid')).toBe('composer-template-pr-review')
  })

  it('selecting a template + submit POSTs the template prompt and closes', async () => {
    const onClose = vi.fn()
    render(<SlateComposer runId="run-1" onClose={onClose} />)

    fireEvent.click(screen.getByTestId('composer-template-pr-review'))
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/compose',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const [, init] = apiFetch.mock.calls.find((c) => c[0] === '/api/runs/run-1/slate/compose')!
    const payload = JSON.parse((init as RequestInit).body as string)
    expect(payload.prompt).toContain('PR review')
    // Delivered → the composer closes (the surface arrives over the SSE run delta).
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('a freeform-only submit POSTs the freeform text (no prompt)', async () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'a deploy checklist' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [, init] = apiFetch.mock.calls[0]!
    const payload = JSON.parse((init as RequestInit).body as string)
    expect(payload.freeform).toBe('a deploy checklist')
    expect(payload.prompt).toBeUndefined()
  })

  it('an empty submit is disabled', () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    expect((screen.getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a create-time recipe is passed through in the compose payload', async () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'a PR review surface' } })
    fireEvent.change(screen.getByTestId('composer-recipe'), { target: { value: 're-run the blind PR eval' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [, init] = apiFetch.mock.calls[0]!
    const payload = JSON.parse((init as RequestInit).body as string)
    expect(payload.recipe).toBe('re-run the blind PR eval')
    expect(payload.freeform).toBe('a PR review surface')
  })

  it('shows "not reachable" and stays open on delivered:false', async () => {
    const onClose = vi.fn()
    apiFetch.mockImplementation(() => okDelivered(false))
    render(<SlateComposer runId="run-1" onClose={onClose} />)

    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(screen.getByTestId('composer-unreachable')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })
})

// The `inline` flag (S6 U5) is what makes the composer safe to leave standing on a
// blank Slate. Driving the component DIRECTLY is the only way to test it: rendered
// inside SlatePanel its visibility isn't derived from any state and its onClose is a
// no-op, so a panel-level test of "it didn't close" passes with the guards deleted.
describe('SlateComposer inline mode (S6 U5)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  it('suppresses Esc / outside-click self-close and the Cancel button', () => {
    const onClose = vi.fn()
    render(<SlateComposer runId="run-1" inline onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(document.body)

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-cancel')).toBeNull()
  })

  it('…and the popover path still self-closes on both (the other direction)', () => {
    const onClose = vi.fn()
    const { unmount } = render(<SlateComposer runId="run-1" onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    const onClose2 = vi.fn()
    render(<SlateComposer runId="run-1" onClose={onClose2} />)
    fireEvent.pointerDown(document.body)
    expect(onClose2).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('composer-cancel')).toBeTruthy()
  })

  it('acknowledges a successful inline submit and clears the form', async () => {
    // The popover's confirmation IS the popover vanishing. Inline there is nothing to
    // vanish, so without this a successful click looks like a dead button — and the
    // obvious recovery (click it again) composes the same surface twice.
    const onClose = vi.fn()
    render(<SlateComposer runId="run-1" inline onClose={onClose} />)

    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'a burndown' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(screen.getByTestId('composer-sent')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByTestId('composer-freeform') as HTMLTextAreaElement).value).toBe('')
    // Cleared form → the submit button is disabled, so a second click can't duplicate.
    expect((screen.getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports whether it is holding an unsent draft', async () => {
    const onDraftChange = vi.fn()
    render(<SlateComposer runId="run-1" inline onClose={vi.fn()} onDraftChange={onDraftChange} />)
    expect(onDraftChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'something' } })
    expect(onDraftChange).toHaveBeenLastCalledWith(true)

    // A recipe alone is still a draft worth protecting.
    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('composer-recipe'), { target: { value: 're-run it' } })
    expect(onDraftChange).toHaveBeenLastCalledWith(true)
  })
})
