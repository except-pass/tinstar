import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../../../apiClient'
import type { ThreadView } from '../types'
import { ContextThread } from '../ContextThread'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(),
}))

interface Call {
  url: string
  body: Record<string, unknown> | null
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Labeled fixture transport. It is not the inbox.
 * fixture: true is on every thread this double returns.
 */
function fixtureTransport() {
  const calls: Call[] = []
  let thread: ThreadView | null = null
  const waiters: Array<() => void> = []

  function snapshot(): ThreadView | null {
    return thread
  }

  function finishWaiters(): void {
    const pending = waiters.splice(0)
    for (const waiter of pending) waiter()
  }

  function applyReply(text: string): void {
    if (!thread) return
    const ordered: ThreadView['messages'] = []
    for (const message of thread.messages) {
      if (message.role !== 'user') continue
      if (message.pending) {
        ordered.push({ ...message, pending: false, disposition: 'replied' })
        ordered.push({
          id: `reply:${message.requestId}`,
          role: 'firstmate',
          text,
          disposition: 'replied',
          noteId: message.noteId,
          requestId: message.requestId,
          previousNoteId: null,
          pending: false,
          detail: '',
        })
      } else {
        ordered.push(message)
        const reply = thread.messages.find(item => item.id === `reply:${message.requestId}`)
        if (reply) ordered.push(reply)
      }
    }
    thread = { ...thread, messages: ordered }
  }

  const fetch = vi.mocked(apiFetch)
  fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ url: path, body })
    if (path.startsWith('/api/v6/threads?')) {
      return json({ ok: true, data: { thread: snapshot() } })
    }
    if (path === '/api/v6/threads/presence') {
      if (thread && body?.archived === true) {
        thread = {
          ...thread,
          display: { ...thread.display, status: 'changed', changedLine: `changed — ${thread.anchor.ids.join(', ')}` },
        }
      } else if (thread && body?.archived === false) {
        const position = body.position as ThreadView['display']['position']
        thread = {
          ...thread,
          display: { status: 'current', changedLine: null, position: position ?? thread.display.position },
        }
      }
      return json({ ok: true, data: { thread: snapshot() } })
    }
    if (path === '/api/v6/threads' && init?.method === 'POST') {
      const postedAnchor = body?.anchor as ThreadView['anchor']
      const requestId = String(body?.requestId)
      const text = String(body?.text)
      if (!thread) {
        thread = {
          id: 'thr-fixture',
          fixture: true,
          anchor: {
            type: postedAnchor.type,
            ids: [...postedAnchor.ids],
            textSelection: postedAnchor.textSelection ?? null,
            revision: postedAnchor.revision ?? null,
            labels: postedAnchor.labels ?? [],
          },
          display: { status: 'current', changedLine: null, position: null },
          messages: [],
        }
      }
      const existing = thread.messages.find(message => message.requestId === requestId && message.role === 'user')
      if (!existing) {
        const previous = [...thread.messages].reverse().find(message => message.role === 'user')
        thread = {
          ...thread,
          messages: [...thread.messages, {
            id: requestId,
            role: 'user',
            text,
            disposition: 'queued',
            noteId: `note-${thread.messages.filter(message => message.role === 'user').length + 1}`,
            requestId,
            previousNoteId: previous?.noteId ?? null,
            pending: true,
            detail: 'queued',
          }],
        }
      }
      return json({ ok: true, data: { thread: snapshot() } })
    }
    if (path.endsWith('/receipts')) {
      return new Promise(resolve => {
        waiters.push(() => resolve(json({ ok: true, data: { thread: snapshot() } })))
      })
    }
    return json({ ok: false, error: { message: `unexpected ${path}` } })
  })

  return {
    calls,
    /** Resolve held receipt polls. A string becomes the reply for every still-pending turn. */
    release(text: string | null) {
      if (text) applyReply(text)
      finishWaiters()
    },
  }
}

const anchor = {
  type: 'epic' as const,
  ids: ['epic-alpha'],
  labels: ['Alpha'],
  textSelection: { text: 'selected title' },
}

describe('ContextThread fixture', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('stays collapsed, shows an indicator, and says fixture', async () => {
    fixtureTransport()
    render(<ContextThread anchor={anchor} fixture />)
    const toggle = screen.getByRole('button', { name: /thread/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('thread-indicator')).toHaveTextContent('0')
    expect(screen.getByText('fixture')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message First Mate')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Message First Mate')).toBeInTheDocument()
    expect(screen.getByText('selection: selected title')).toBeInTheDocument()
    expect(screen.getByText(/first mate/i)).toBeInTheDocument()
  })

  it('shows queued until the fixture reply arrives, then keeps both turns in order', async () => {
    const transport = fixtureTransport()
    render(<ContextThread anchor={anchor} fixture />)
    fireEvent.click(screen.getByRole('button', { name: /thread/i }))
    fireEvent.change(screen.getByLabelText('Message First Mate'), { target: { value: 'first turn' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Context thread' }))

    expect(await screen.findByText('queued')).toBeInTheDocument()
    expect(screen.getByText('first turn')).toBeInTheDocument()
    expect(screen.queryByText('captain says hi')).not.toBeInTheDocument()

    const posts = transport.calls.filter(call => call.url === '/api/v6/threads')
    const firstRequest = String(posts[0]?.body?.requestId)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      const retries = transport.calls.filter(call => call.url === '/api/v6/threads' && call.body?.requestId === firstRequest)
      expect(retries.length).toBeGreaterThan(1)
    })
    expect(screen.getAllByText('first turn')).toHaveLength(1)

    transport.release('captain says hi')
    expect(await screen.findByText('captain says hi')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('queued')).not.toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Message First Mate'), { target: { value: 'second turn' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Context thread' }))
    expect(await screen.findByText('second turn')).toBeInTheDocument()
    const secondPost = transport.calls.filter(call => call.body?.text === 'second turn').at(-1)
    expect(secondPost?.body?.threadId).toBe('thr-fixture')
    expect(secondPost?.body?.requestId).not.toBe(firstRequest)
    expect((secondPost?.body?.anchor as { ids: string[] }).ids).toEqual(['epic-alpha'])
    const messages = screen.getAllByRole('listitem')
    expect(messages.map(item => item.textContent)).toEqual([
      expect.stringContaining('first turn'),
      expect.stringContaining('captain says hi'),
      expect.stringContaining('second turn'),
    ])

    transport.release('second reply')
    expect(await screen.findByText('second reply')).toBeInTheDocument()
    const ordered = screen.getAllByRole('listitem').map(item => item.textContent ?? '')
    expect(ordered[0]).toContain('first turn')
    expect(ordered[1]).toContain('captain says hi')
    expect(ordered[2]).toContain('second turn')
    expect(ordered[3]).toContain('second reply')

    fireEvent.click(screen.getByRole('button', { name: /thread/i }))
    expect(screen.queryByText('first turn')).not.toBeInTheDocument()
    expect(screen.getByTestId('thread-indicator')).toHaveTextContent('4')
    expect(screen.getByText('fixture')).toBeInTheDocument()
  })

  it('keeps the earlier ids and a changed line when the anchor is archived', async () => {
    const transport = fixtureTransport()
    const view = render(<ContextThread anchor={anchor} fixture placement={{ archived: false, occupantIds: ['epic-alpha'], position: { columnId: 'col-a', index: 0 } }} />)
    fireEvent.click(screen.getByRole('button', { name: /thread/i }))
    fireEvent.change(screen.getByLabelText('Message First Mate'), { target: { value: 'stay with the card' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Context thread' }))
    expect(await screen.findByText('stay with the card')).toBeInTheDocument()
    transport.release(null)

    view.rerender(<ContextThread anchor={anchor} fixture placement={{ archived: false, occupantIds: ['epic-alpha'], position: { columnId: 'col-b', index: 3 } }} />)
    await waitFor(() => expect(screen.getByTestId('thread-indicator')).toHaveTextContent('1'))
    expect(screen.getByText('stay with the card')).toBeInTheDocument()
    expect(screen.queryByTestId('thread-changed')).not.toBeInTheDocument()

    view.rerender(<ContextThread anchor={anchor} fixture placement={{ archived: true, occupantIds: ['usurper'], position: { columnId: 'col-b', index: 3 } }} />)
    expect(await screen.findByTestId('thread-changed')).toHaveTextContent('changed — epic-alpha')
    expect(screen.getByText('stay with the card')).toBeInTheDocument()
    expect(screen.getByText(/epic · epic-alpha/)).toBeInTheDocument()
    expect(screen.queryByText(/usurper/)).not.toBeInTheDocument()
  })

  it('does not fetch when nothing is anchored', () => {
    const transport = fixtureTransport()
    render(<ContextThread />)
    expect(screen.getByText(/point at an epic/i)).toBeInTheDocument()
    expect(transport.calls).toHaveLength(0)
  })
})
