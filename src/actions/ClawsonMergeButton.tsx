import { useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { PullSummary } from '../shared/pulls'
import type { ClawsonMergeInput } from '../shared/clawsonMerge'

export function ClawsonMergeButton({ targets }: { targets: PullSummary[] }) {
  const pending = useRef(false), attempt = useRef<{ selection: string; input: ClawsonMergeInput }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [sent, setSent] = useState<{ url: string; message: string } | null>(null)
  const send = async () => {
    if (pending.current || !targets.length) return
    pending.current = true; setBusy(true); setError('')
    const selection = JSON.stringify(targets.map(({ url, head }) => ({ url, head })).sort((a, b) => a.url.localeCompare(b.url)))
    if (attempt.current?.selection !== selection) attempt.current = { selection, input: { operation_id: crypto.randomUUID(), targets: JSON.parse(selection) } }
    try {
      const response = await apiFetch('/api/pulls/clawson-merge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify(attempt.current.input) })
      const body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? 'Could not send to Clawson. Retry this click.')
      setSent(body.data)
    } catch (error) { setError((error as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="pr-clawson-action">
    <button type="button" disabled={busy || !targets.length} onClick={() => void send()}>{busy ? 'Checking PRs and sending…' : 'Send to Clawson for admin merge'}</button>
    <small>This click gives your merge word for the selected PRs at their current heads. Up to 10 per card.</small>
    {error && <p role="alert">{error}</p>}
    {sent && <p role="status">{sent.message} <a href={sent.url} target="_blank" rel="noreferrer">Open Clawson card ↗</a></p>}
  </div>
}
