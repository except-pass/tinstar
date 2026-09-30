// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { ComposerInput } from '../PromptComposer'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
  apiUrl: (path: string) => path,
}))

const ORIG_FETCH = global.fetch

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { path: '/tmp/notes.txt' } }),
  }) as unknown as Response)
  global.URL.createObjectURL = vi.fn(() => 'blob:test')
  global.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  global.fetch = ORIG_FETCH
  vi.restoreAllMocks()
})

function renderComposer() {
  return render(
    <ComposerInput
      sessionId="run-1"
      status="idle"
      accent="#ff7700"
      expanded
    />,
  )
}

describe('ComposerInput — file drop', () => {
  it('shows a drop target while files are dragged', () => {
    const { getByTestId, queryByTestId } = renderComposer()
    expect(queryByTestId('prompt-composer-drop-target')).toBeNull()
    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'], files: [] } })
    expect(getByTestId('prompt-composer-drop-target')).toBeTruthy()
    expect(getByTestId('prompt-composer').getAttribute('data-file-drag')).toBe('true')
  })

  it('uploads each dropped file and inserts its reference', async () => {
    const { container, getByTestId } = renderComposer()
    const composer = getByTestId('prompt-composer')
    const note = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const shot = new File([new Uint8Array([1, 2])], 'shot.png', { type: 'image/png' })
    fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [note, shot] } })
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await waitFor(() => {
      expect(ta.value).toContain('@/tmp/notes.txt')
    })
    expect(container.querySelector('[data-testid^="thumb-file-"]')?.textContent).toContain('notes.txt')
    expect(container.querySelector('[data-testid^="thumb-tile-"] img')).not.toBeNull()
  })

  it('expands a collapsed composer on drop and keeps the dropped file reference', async () => {
    function Docked() {
      const [open, setOpen] = useState(false)
      return <ComposerInput sessionId="run-1" status="idle" accent="#ff7700" expanded={open} onToggle={() => setOpen(o => !o)} />
    }
    const { container, getByTestId } = render(<Docked />)
    expect(container.querySelector('textarea')).toBeNull()
    const note = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.drop(getByTestId('prompt-composer'), { dataTransfer: { types: ['Files'], files: [note] } })
    await waitFor(() => {
      expect((container.querySelector('textarea') as HTMLTextAreaElement | null)?.value).toContain('@/tmp/notes.txt')
    })
  })

  it('keeps a file dropped outside the composer from opening in the page', () => {
    renderComposer()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const note = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const allowed = fireEvent.drop(outside, { dataTransfer: { types: ['Files'], files: [note] } })
    expect(allowed).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
    outside.remove()
  })

  it('clears the drop target when the drag leaves the window', () => {
    const { getByTestId, queryByTestId } = renderComposer()
    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'], files: [] } })
    expect(getByTestId('prompt-composer-drop-target')).toBeTruthy()
    fireEvent.dragLeave(window, { dataTransfer: { types: ['Files'], files: [] }, relatedTarget: null })
    expect(queryByTestId('prompt-composer-drop-target')).toBeNull()
  })
})
