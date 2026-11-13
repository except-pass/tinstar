import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { CardLease } from '../server/reconciliation/cardLeases'

/** No capability enters the browser. Owner release uses the existing verified
 * owner authority and the displayed generation, never a conversation token. */
export function CardLeaseStatus({ cardId }: { cardId: string }) {
  const [state, setState] = useState<{ lease: CardLease | null; can_release: boolean } | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch('/api/reconciliation/workflow', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation: 'lease', input: { card_id: cardId } }) })
    const body = await response.json()
    if (!signal?.aborted) {
      if (body.ok) setState(body.data)
      else setMessage(body.error?.message ?? 'Lease status unavailable')
    }
  }, [cardId])
  useEffect(() => {
    const controller = new AbortController()
    setState(null); setMessage('')
    const refresh = () => { void load(controller.signal).catch(() => { if (!controller.signal.aborted) setMessage('Lease status unavailable') }) }
    refresh()
    const timer = setInterval(refresh, 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [load])
  async function release() {
    if (!state?.lease) return
    setBusy(true); setMessage('')
    try {
      const response = await apiFetch('/api/reconciliation/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' },
        body: JSON.stringify({ operation: 'release-lease', input: { card_id: cardId, generation: state.lease.generation, reason: 'Owner released from card' } }) })
      const body = await response.json()
      setMessage(body.ok ? body.data.message ?? (body.data.outcome === 'released' ? 'Lease released.' : 'Lease already released.') : body.error?.message ?? 'Release failed')
      await load()
    } catch { setMessage('Release unconfirmed. Reload the card to check its holder.') }
    finally { setBusy(false) }
  }
  return <section aria-label="Card lease" className="ov-source-actions">
    {state?.lease && <><span>Held by {state.lease.holder} until <time dateTime={state.lease.expires_at}>{new Date(state.lease.expires_at).toLocaleString()}</time></span>{state.can_release && <button type="button" disabled={busy} onClick={() => void release()}>{busy ? 'Releasing…' : 'Release lease'}</button>}</>}
    {message && <p role="status">{message}</p>}
  </section>
}
