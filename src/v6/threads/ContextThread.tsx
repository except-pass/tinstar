import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../apiClient'
import type { AnchorType } from '../contract/intent'
import {
  dispositionLabel,
  type ThreadAnchorInput,
  type ThreadMessageView,
  type ThreadPlacement,
  type ThreadView,
} from './types'

export interface ContextThreadProps {
  anchor?: ThreadAnchorInput
  placement?: ThreadPlacement
  fixture?: boolean
}

interface Envelope {
  ok: boolean
  data?: { thread: ThreadView | null }
  error?: { message?: string }
}

function newRequestId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return `req-${cryptoObj.randomUUID()}`
  return `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

function anchorKey(anchor: ThreadAnchorInput | undefined): string {
  if (!anchor) return ''
  return `${anchor.type}:${[...anchor.ids].sort().join(',')}`
}

function placementKey(placement: ThreadPlacement | undefined): string {
  if (!placement) return ''
  const occupants = placement.occupantIds?.join(',') ?? ''
  const column = placement.position?.columnId ?? ''
  const index = placement.position?.index ?? ''
  return `${placement.archived ? 'archived' : 'current'}:${occupants}:${column}:${index}`
}

async function readEnvelope(response: Response): Promise<Envelope> {
  try {
    return await response.json() as Envelope
  } catch {
    return { ok: false, error: { message: 'thread response was not JSON' } }
  }
}

export function ContextThread({ anchor, placement, fixture = false }: ContextThreadProps = {}) {
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState<ThreadView | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const key = anchorKey(anchor)
  const place = placementKey(placement)
  const anchorRef = useRef(anchor)
  const placementRef = useRef(placement)
  const generation = useRef(0)
  anchorRef.current = anchor
  placementRef.current = placement

  useEffect(() => {
    const current = anchorRef.current
    const placed = placementRef.current
    if (!current || current.ids.length === 0) return
    const ticket = ++generation.current
    const ids = current.ids.join(',')
    const listUrl = `/api/v6/threads?type=${encodeURIComponent(current.type)}&ids=${encodeURIComponent(ids)}`
    void (async () => {
      const listed = await readEnvelope(await apiFetch(listUrl))
      if (ticket !== generation.current) return
      let next = listed.data?.thread ?? null
      if (placed) {
        const presence = await readEnvelope(await apiFetch('/api/v6/threads/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: current.type,
            ids: current.ids,
            archived: placed.archived === true,
            occupantIds: placed.occupantIds,
            position: placed.position,
          }),
        }))
        if (ticket !== generation.current) return
        if (presence.ok) next = presence.data?.thread ?? next
      }
      setThread(next)
      if (!next || !next.messages.some(message => message.pending)) return
      const refreshed = await readEnvelope(await apiFetch(`/api/v6/threads/${encodeURIComponent(next.id)}/receipts`, {
        method: 'POST',
      }))
      if (ticket === generation.current && refreshed.data?.thread) setThread(refreshed.data.thread)
    })().catch((err: unknown) => {
      if (ticket === generation.current) setError(err instanceof Error ? err.message : 'thread could not be loaded')
    })
  }, [key, place])

  const messages = thread?.messages ?? []
  const showFixture = fixture || thread?.fixture === true
  const ids = thread?.anchor.ids ?? anchor?.ids ?? []
  const anchorType: AnchorType | null = thread?.anchor.type ?? anchor?.type ?? null
  const changedLine = thread?.display.changedLine ?? null

  async function send(requestId: string, text: string, threadId: string | undefined) {
    const current = anchorRef.current
    if (!current) return
    const ticket = ++generation.current
    setSending(true)
    setError(null)
    try {
      const posted = await readEnvelope(await apiFetch('/api/v6/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          requestId,
          text,
          fixture,
          anchor: {
            type: current.type,
            ids: current.ids,
            textSelection: current.textSelection ?? null,
            labels: current.labels ?? [],
            revision: current.revision ?? null,
          },
        }),
      }))
      if (ticket !== generation.current) return
      if (!posted.ok || !posted.data?.thread) {
        setError(posted.error?.message ?? 'message was not saved')
        setSending(false)
        return
      }
      setThread(posted.data.thread)
      setDraft('')
      setSending(false)
      if (posted.data.thread.messages.some(message => message.pending)) {
        const refreshed = await readEnvelope(await apiFetch(`/api/v6/threads/${encodeURIComponent(posted.data.thread.id)}/receipts`, {
          method: 'POST',
        }))
        if (ticket === generation.current && refreshed.data?.thread) setThread(refreshed.data.thread)
      }
    } catch (err) {
      if (ticket === generation.current) {
        setError(err instanceof Error ? err.message : 'message was not saved')
        setSending(false)
      }
    }
  }

  if (!anchor || anchor.ids.length === 0) {
    return (
      <section className="rounded border border-primary/30 bg-surface-panel px-3 py-2 text-ink-low" data-recipient="firstmate">
        <p className="font-display text-xs uppercase tracking-wider text-primary">Thread</p>
        <p className="mt-1 text-sm">Point at an epic, a plan, or a task to talk about it with First Mate.</p>
      </section>
    )
  }

  return (
    <section
      className="rounded border border-primary/30 bg-surface-panel text-ink-mid transition-colors duration-150 motion-reduce:transition-none"
      data-recipient="firstmate"
      data-thread-id={thread?.id ?? ''}
      data-anchor-ids={ids.join(' ')}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="font-display text-xs uppercase tracking-wider text-primary">Thread</span>
        <span
          data-testid="thread-indicator"
          data-count={messages.length}
          className="rounded-full bg-primary/15 px-1.5 text-[11px] text-primary"
        >
          {messages.length}
        </span>
        {anchorType && (
          <span className="truncate text-xs text-ink-low">{anchorType} · {ids.join(', ')}</span>
        )}
        {showFixture && <span className="text-xs uppercase tracking-wider text-accent-amber">fixture</span>}
      </button>
      {open && (
        <div className="border-t border-primary/20 px-3 py-2">
          {changedLine && (
            <p className="mb-2 text-xs text-hue-discussing" data-testid="thread-changed">{changedLine}</p>
          )}
          <p className="mb-2 text-xs uppercase tracking-wider text-ink-low">To First Mate</p>
          {anchor?.textSelection && (
            <p className="mb-2 text-xs text-ink-low">selection: {anchor.textSelection.text}</p>
          )}
          <ol className="space-y-2">
            {messages.map(message => (
              <MessageRow key={message.id} message={message} onRetry={requestId => {
                const turn = messages.find(item => item.requestId === requestId && item.role === 'user')
                if (!turn || sending) return
                void send(requestId, turn.text, thread?.id)
              }} />
            ))}
          </ol>
          <form
            className="mt-2 flex gap-2"
            aria-label="Context thread"
            onSubmit={event => {
              event.preventDefault()
              const text = draft.trim()
              if (!text || sending) return
              void send(newRequestId(), text, thread?.id)
            }}
          >
            <textarea
              aria-label="Message First Mate"
              className="min-h-16 flex-1 rounded border border-primary/30 bg-surface-base px-2 py-1 text-sm text-ink-high"
              value={draft}
              placeholder="Talk to First Mate about this"
              onChange={event => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="rounded bg-primary/20 px-3 text-sm text-primary disabled:opacity-50"
              disabled={sending || draft.trim().length === 0}
            >
              Send
            </button>
          </form>
          {error && <p className="mt-2 text-xs text-hue-error">{error}</p>}
        </div>
      )}
    </section>
  )
}

function MessageRow({ message, onRetry }: { message: ThreadMessageView; onRetry: (requestId: string) => void }) {
  const label = message.pending ? dispositionLabel(message.disposition) : message.disposition === 'failed' ? message.detail || 'failed' : null
  return (
    <li className="text-sm" data-role={message.role} data-disposition={message.disposition}>
      <span className="mr-2 text-[11px] uppercase tracking-wider text-ink-low">
        {message.role === 'user' ? 'You' : 'First Mate'}
      </span>
      <span className="text-ink-high">{message.text}</span>
      {label && (
        <span className={message.disposition === 'failed' ? 'ml-2 text-xs text-hue-error' : 'ml-2 text-xs text-hue-waiting'}>
          {label}
        </span>
      )}
      {message.pending && message.requestId && (
        <button
          type="button"
          className="ml-2 text-xs text-primary"
          onClick={() => {
            const requestId = message.requestId
            if (requestId) onRetry(requestId)
          }}
        >
          Retry
        </button>
      )}
    </li>
  )
}
