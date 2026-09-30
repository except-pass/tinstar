import { useEffect, useRef, useState } from 'react'
import { getAvatarDataUrl, subscribeAvatarCache } from '../../components/agentAvatarCache'
import { PALETTE_COLORS } from '../../components/ColorPalette'
import type { Draft, SubmitResult, Worker } from './types'

export function identityColor(id: string): string {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return PALETTE_COLORS[(hash % 8) * 3 + 1]!
}

export function Face({ worker, size = 40 }: { worker: Worker; size?: number }) {
  const [, refresh] = useState(0)
  useEffect(() => subscribeAvatarCache(() => refresh(n => n + 1)), [])
  const color = identityColor(worker.id)
  const avatar = getAvatarDataUrl(worker.id, color)
  return <span className="cockpit-face" style={{ width: size, height: size, borderColor: color }}>
    {avatar ? <img src={avatar} alt="" /> : <span aria-hidden="true">✦</span>}
  </span>
}

export function StateChip({ state }: { state: string }) {
  return <span className={`cockpit-state cockpit-state-${state.toLowerCase().replace(/[^a-z0-9-]/g, '')}`}>{state}</span>
}

export function MateBadge({ kind }: { kind: string }) {
  if (kind !== 'secondmate') return null
  return <span className="cockpit-mate">Second mate</span>
}

export function mintRequestId(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `tinstar-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function Composer({ anchorKey, kind, submit }: { anchorKey: string; kind: 'answer' | 'message'; submit: (draft: Draft) => Promise<SubmitResult> }) {
  const [text, setText] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)
  const label = kind === 'answer' ? 'Answer this decision' : 'Tell First Mate about this'
  return <form className="cockpit-composer" onSubmit={event => {
    event.preventDefault()
    if (inFlight.current || !text.trim()) return
    const id = requestId ?? mintRequestId()
    inFlight.current = true; setBusy(true); setNotice(null)
    setRequestId(id)
    void submit({ requestId: id, anchorKey, kind, text: text.trim() }).then(result => {
      if (result.saved) { setText(''); setRequestId(null); setNotice(result.error ?? (result.canReceive === false ? 'Saved, not yet read. First Mate will read it when it wakes.' : 'Saved. First Mate will receive it at the next check.')) }
      else setNotice(result.error ?? 'Could not confirm the message was saved. Retry with the same request ID.')
    }).catch(error => setNotice((error as Error).message)).finally(() => { inFlight.current = false; setBusy(false) })
  }}>
    <label>{label}<textarea value={text} onChange={event => { setText(event.target.value); setRequestId(null) }} rows={3} maxLength={10000} placeholder={kind === 'answer' ? 'Write your answer…' : 'Write your message…'} /></label>
    <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : requestId ? 'Retry' : 'Send to First Mate'}</button>
    {notice && <p role="status">{notice}</p>}
  </form>
}
