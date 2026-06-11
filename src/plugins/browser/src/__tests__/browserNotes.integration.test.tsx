// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { makeBrowserPrimitive } from '../BrowserPrimitive'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import type { BrowserNote } from '../../../../domain/types'

const httpFetch = vi.fn()
const api = {
  theme: { accent: { hexToRgba: (_c: string, a: number) => `rgba(0,0,0,${a})` } },
  constellations: { Badge: () => null },
  hotkeys: { onAction: () => ({ dispose() {} }) },
  canvas: { fitWidget: () => {} },
  http: { fetch: httpFetch },
} as unknown as TinstarPluginAPI

const BrowserPrimitive = makeBrowserPrimitive(api)

const note = (over: Partial<BrowserNote> = {}): BrowserNote => ({
  id: 'n1', url: 'http://localhost:3000/', comment: 'make it pop', x: 10, y: 20, nx: 0, ny: 0, createdAt: 1, ...over,
})

const baseProps = {
  nodeId: 'w1', hotkeyId: 'w1', url: 'http://localhost:3000/', accent: '#abc',
  onNavigate: vi.fn(), slots: [] as string[],
}

const okEnvelope = () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: null }) })

beforeEach(() => httpFetch.mockReset())

describe('BrowserPrimitive notes integration', () => {
  it('hides the notes toolbar when onNotesChange is not provided', () => {
    render(<BrowserPrimitive {...baseProps} />)
    expect(screen.queryByTestId('bw-notes-toolbar')).toBeNull()
  })

  it('places a coords-only note on click (jsdom has no elementFromPoint)', () => {
    const onNotesChange = vi.fn()
    render(<BrowserPrimitive {...baseProps} notes={[]} onNotesChange={onNotesChange} sessionId="sess-1" />)
    fireEvent.click(screen.getByTestId('bw-notes-add'))
    fireEvent.click(screen.getByTestId('bw-notes-placement-layer'), { clientX: 100, clientY: 150 })
    expect(onNotesChange).toHaveBeenCalledTimes(1)
    const placed = onNotesChange.mock.calls[0]![0] as BrowserNote[]
    expect(placed).toHaveLength(1)
    expect(placed[0]!.url).toBe('http://localhost:3000/')
    expect(placed[0]!.x).toBe(100)
    expect(placed[0]!.y).toBe(150)
    expect(placed[0]!.sentAt).toBeUndefined()
    // placing mode ends after the drop; the new note's popover is open
    expect(screen.queryByTestId('bw-notes-placement-layer')).toBeNull()
    expect(screen.getByTestId(`bw-note-comment-${placed[0]!.id}`)).toBeInTheDocument()
  })

  it('Escape cancels placing mode', () => {
    render(<BrowserPrimitive {...baseProps} notes={[]} onNotesChange={vi.fn()} sessionId="sess-1" />)
    fireEvent.click(screen.getByTestId('bw-notes-add'))
    expect(screen.getByTestId('bw-notes-placement-layer')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('bw-notes-placement-layer')).toBeNull()
  })

  it('submit posts unsent notes to enter-prompt and marks them sent', async () => {
    httpFetch.mockResolvedValue(okEnvelope())
    const onNotesChange = vi.fn()
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" onNotesChange={onNotesChange}
      notes={[note(), note({ id: 'n2', comment: 'old', sentAt: 5 })]} />)
    fireEvent.click(screen.getByTestId('bw-notes-submit'))
    await waitFor(() => expect(onNotesChange).toHaveBeenCalled())
    const [url, init] = httpFetch.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('/api/sessions/sess-1/enter-prompt')
    const body = JSON.parse(init.body)
    expect(body.prompt).toContain('make it pop')
    expect(body.prompt).not.toContain('old')                 // already sent — excluded
    const updated = onNotesChange.mock.calls[0]![0] as BrowserNote[]
    expect(updated.find(n => n.id === 'n1')!.sentAt).toBeTypeOf('number')
    expect(updated.find(n => n.id === 'n2')!.sentAt).toBe(5) // untouched
  })

  it('failed submit keeps notes unsent and shows the error', async () => {
    httpFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'boom' } }) })
    const onNotesChange = vi.fn()
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" onNotesChange={onNotesChange} notes={[note()]} />)
    fireEvent.click(screen.getByTestId('bw-notes-submit'))
    await waitFor(() => expect(screen.getByTestId('bw-notes-error')).toBeInTheDocument())
    expect(onNotesChange).not.toHaveBeenCalled()
  })

  it('submit is disabled without an attached session', () => {
    render(<BrowserPrimitive {...baseProps} onNotesChange={vi.fn()} notes={[note()]} />)
    expect(screen.getByTestId('bw-notes-submit')).toBeDisabled()
  })

  it('clear-all double-click empties notes', () => {
    const onNotesChange = vi.fn()
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" onNotesChange={onNotesChange} notes={[note()]} />)
    fireEvent.click(screen.getByTestId('bw-notes-clear'))
    fireEvent.click(screen.getByTestId('bw-notes-clear'))
    expect(onNotesChange).toHaveBeenCalledWith([])
  })

  it('full place→comment→submit flow: typed comment reaches formatter and is marked sent', async () => {
    httpFetch.mockResolvedValue(okEnvelope())
    const onNotesChange = vi.fn()
    render(<BrowserPrimitive {...baseProps} notes={[]} onNotesChange={onNotesChange} sessionId="sess-1" />)

    // enter placing mode and drop a note
    fireEvent.click(screen.getByTestId('bw-notes-add'))
    fireEvent.click(screen.getByTestId('bw-notes-placement-layer'), { clientX: 200, clientY: 300 })

    // get the new note's id from the first onNotesChange call
    expect(onNotesChange).toHaveBeenCalledTimes(1)
    const placed = onNotesChange.mock.calls[0]![0] as BrowserNote[]
    const newId = placed[0]!.id

    // the popover textarea is open — type the comment and blur
    const textarea = screen.getByTestId(`bw-note-comment-${newId}`)
    fireEvent.change(textarea, { target: { value: 'ship it' } })
    fireEvent.blur(textarea)

    // submit — expect httpFetch to be called
    fireEvent.click(screen.getByTestId('bw-notes-submit'))
    await waitFor(() => expect(httpFetch).toHaveBeenCalled())

    // the POST body prompt contains the typed comment, not the empty initial value
    const [, init] = httpFetch.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body)
    expect(body.prompt).toContain('ship it')

    // the last onNotesChange call has the note marked sent with comment 'ship it'
    const lastCall = onNotesChange.mock.calls[onNotesChange.mock.calls.length - 1]![0] as BrowserNote[]
    const sentNote = lastCall.find(n => n.id === newId)!
    expect(sentNote.sentAt).toBeTypeOf('number')
    expect(sentNote.comment).toBe('ship it')
  })

  it('hides pins from other pages but keeps them in state', () => {
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" onNotesChange={vi.fn()}
      notes={[note(), note({ id: 'n2', url: 'http://localhost:3000/other' })]} />)
    expect(screen.getByTestId('bw-note-pin-n1')).toBeInTheDocument()
    expect(screen.queryByTestId('bw-note-pin-n2')).toBeNull()
    // other-page note still counts toward unsent badge (it will be submitted)
    expect(screen.getByTestId('bw-notes-unsent-badge')).toHaveTextContent('2')
  })
})
