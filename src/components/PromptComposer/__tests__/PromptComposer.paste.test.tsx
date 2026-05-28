// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { PromptComposer } from '../PromptComposer'
import type { RecapEntry } from '../../../types'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  })),
  apiUrl: (path: string) => path,
}))

vi.mock('../../../hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({ commands: [], usage: {}, refresh: () => {} }),
}))

const ACCENT = '#ff7700'
const NO_ENTRIES: RecapEntry[] = []

const ORIG_FETCH = global.fetch

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { path: '/abs/shot.png' } }),
  }) as unknown as Response)
  global.URL.createObjectURL = vi.fn(() => 'blob:test')
  global.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  global.fetch = ORIG_FETCH
  vi.restoreAllMocks()
})

function renderComposer(overrides: Partial<React.ComponentProps<typeof PromptComposer>> = {}) {
  return render(
    <PromptComposer
      recapEntries={NO_ENTRIES}
      rawLogs=""
      port={undefined}
      sessionId="run-1"
      status="idle"
      accent={ACCENT}
      promptComposerExpanded={true}
      controlledTab="recap"
      onControlledTabChange={() => {}}
      {...overrides}
    />,
  )
}

function makeImagePasteEvent(file: File): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: [{
        type: file.type,
        kind: 'file',
        getAsFile: () => file,
      }],
      types: ['Files'],
    },
  })
  return event
}

describe('PromptComposer — image paste', () => {
  it('text-only paste does not trigger upload', async () => {
    const { container } = renderComposer()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [], types: ['text/plain'] },
    })
    fireEvent(ta, event)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('image paste uploads via /api/screenshots and inserts @<path> at cursor', async () => {
    const { container } = renderComposer()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    ta.value = 'hello '
    ta.selectionStart = ta.selectionEnd = ta.value.length
    const file = new File([new Uint8Array([0x89, 0x50])], 'paste.png', { type: 'image/png' })
    fireEvent(ta, makeImagePasteEvent(file))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/screenshots', expect.objectContaining({ method: 'POST' }))
    })
    await waitFor(() => {
      expect(ta.value).toContain('@/abs/shot.png')
    })
  })

  it('thumbnail tile appears in the strip after upload', async () => {
    const { container } = renderComposer()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    const file = new File([new Uint8Array([0x89])], 'p.png', { type: 'image/png' })
    fireEvent(ta, makeImagePasteEvent(file))
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thumbnail-strip"]')).not.toBeNull()
    })
  })

  it('submit button is disabled while an upload is pending', async () => {
    let resolveFetch!: (v: Response) => void
    global.fetch = vi.fn(() => new Promise<Response>((r) => { resolveFetch = r }))
    const { container } = renderComposer()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    const file = new File([new Uint8Array([0x89])], 'p.png', { type: 'image/png' })
    fireEvent(ta, makeImagePasteEvent(file))
    await waitFor(() => {
      const submit = container.querySelector('[data-testid="composer-submit"]') as HTMLButtonElement
      expect(submit?.disabled).toBe(true)
    })
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ data: { path: '/abs/done.png' } }),
    } as unknown as Response)
    await waitFor(() => {
      const submit = container.querySelector('[data-testid="composer-submit"]') as HTMLButtonElement
      expect(submit?.disabled).toBe(false)
    })
  })

  it('clears thumbnail strip after a successful submit', async () => {
    const { container } = renderComposer()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    const file = new File([new Uint8Array([0x89])], 'p.png', { type: 'image/png' })
    fireEvent(ta, makeImagePasteEvent(file))
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thumbnail-strip"]')).not.toBeNull()
    })

    // Upload finishes and path is inserted — wait for submit to become enabled
    const submit = container.querySelector('[data-testid="composer-submit"]') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))

    // apiFetch is already mocked to return { ok: true } for any call (see top of file)
    // Ensure there is text so canSend is true (path token was inserted by paste handler)
    expect(ta.value).toContain('@/abs/shot.png')

    fireEvent.click(submit)

    // After successful submit the strip must be gone
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thumbnail-strip"]')).toBeNull()
    })
  })

  it('removing a tile also removes the @token from the textarea', async () => {
    const { container } = renderComposer()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    const file = new File([new Uint8Array([0x89])], 'p.png', { type: 'image/png' })
    fireEvent(ta, makeImagePasteEvent(file))
    await waitFor(() => expect(ta.value).toContain('@/abs/shot.png'))
    const removeBtn = container.querySelector('[data-testid^="thumb-remove-"]') as HTMLButtonElement
    fireEvent.click(removeBtn)
    expect(ta.value).not.toContain('@/abs/shot.png')
  })
})
