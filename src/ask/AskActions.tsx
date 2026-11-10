import { useRef, useState } from 'react'
import type { AskAction, AskSuggestion } from '../shared/ask-actions'
import type { AskSelectionInput } from '../shared/ask'
import { sendSuggestedMerge, type SuggestedMergeCard } from './suggestedMerge'
import './ask-actions.css'

/** Adapter for the selected conversation turn. No browser prose
 * enters the selection request; the store must resolve the retained instruction.
 */
/** Only a definitive HTTP rejection may use this error. A transport error has
 * unknown acceptance and must retain the original idempotency key. */
export class AskSelectionRejected extends Error {}
export interface AskActionDelivery {
  status: 'sent' | 'delivered' | 'answered' | 'failed'
  error?: string | null
}
export interface AskActionSelectionState extends AskActionDelivery { action_id: string }
export interface AskActionsProps {
  answerId: string
  suggestions: AskSuggestion[]
  superseded: boolean
  selection?: AskActionSelectionState | null
  onSelect: (input: AskSelectionInput) => Promise<AskActionDelivery>
}
const statusLabel = { sent: 'Requested', delivered: 'Delivered', answered: 'Answered', failed: 'Failed' } as const
interface Attempt { input: AskSelectionInput; delivery?: AskActionDelivery; uncertain?: boolean; rejection?: string }
interface MergeClick { actionId: string; sending?: boolean; error?: string; sent?: SuggestedMergeCard }

export function AskActions(props: AskActionsProps) {
  // Changing the answer resets only local presentation, never a retained turn.
  return <ActionChoices key={props.answerId} {...props} />
}

function ActionChoices({ answerId, suggestions, superseded, selection, onSelect }: AskActionsProps) {
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [merge, setMerge] = useState<MergeClick | null>(null)
  const locked = useRef(false)
  const attemptRef = useRef<Attempt | null>(null)
  const mergeOps = useRef(new Map<string, string>())
  const actions = suggestions.filter((suggestion): suggestion is AskAction => typeof suggestion !== 'string')
  const legacy = suggestions.filter((suggestion): suggestion is string => typeof suggestion === 'string')
  const selectedId = selection?.action_id ?? attempt?.input.action_id
  const selected = actions.find(action => action.id === selectedId)
  const delivery = selection ?? attempt?.delivery
  const uncertain = !selection && attempt?.uncertain
  const unavailable = superseded || !!selectedId || !!merge?.sent || !!merge?.sending

  async function select(action: AskAction) {
    // The ref closes the same-event double-click window before React rerenders.
    // Unknown acknowledgements keep the key and chosen action for reconciliation.
    if (locked.current || superseded || selection || merge?.sent || merge?.sending) return
    if (action.merge) {
      locked.current = true
      const operationId = mergeOps.current.get(action.id) ?? crypto.randomUUID()
      mergeOps.current.set(action.id, operationId)
      setMerge({ actionId: action.id, sending: true })
      try {
        setMerge({ actionId: action.id, sent: await sendSuggestedMerge(action.merge.pr_url, operationId) })
      } catch (reason) {
        setMerge({ actionId: action.id, error: (reason as Error).message })
      } finally { locked.current = false }
      return
    }
    if (attemptRef.current && attemptRef.current.input.action_id !== action.id) return
    if (attemptRef.current && !attemptRef.current.uncertain) return
    locked.current = true
    const current: Attempt = { input: attemptRef.current?.input ?? { answer_id: answerId, action_id: action.id, client_key: crypto.randomUUID() } }
    attemptRef.current = current
    setAttempt(current)
    try {
      const next = { ...current, delivery: await onSelect(current.input) }
      attemptRef.current = next
      setAttempt(next)
    } catch (reason) {
      // A lost response does not prove that the server rejected the selection.
      const next = reason instanceof AskSelectionRejected ? { ...current, rejection: reason.message } : { ...current, uncertain: true }
      attemptRef.current = next
      setAttempt(next)
    } finally { locked.current = false }
  }

  if (!suggestions.length) return null
  const button = (action: AskAction) => <button key={action.id} type="button" className="ask-action-choice"
    disabled={unavailable} aria-label={`${action.label}: ${action.instruction}`} title={action.instruction}
    onClick={() => { void select(action) }}>{action.label}</button>

  return <div className="ask-recommendations" role="group" aria-label="Suggested next actions">
    {!!actions.length && <>
      <div className="ask-action-choices">{actions.slice(0, 3).map(button)}</div>
      {actions.length > 3 && <details className="ask-action-overflow"><summary>More choices ({actions.length - 3})</summary>
        <div className="ask-action-choices">{actions.slice(3).map(button)}</div>
      </details>}
    </>}
    {!!legacy.length && <ul className="ask-action-legacy">{legacy.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    {superseded && !!actions.length && <p className="ask-action-explanation">These recommendations are outdated. Use the latest answer’s choices.</p>}
    {merge?.sending && <p role="status">Checking the PR and sending…</p>}
    {merge?.error && <p role="alert">{merge.error}</p>}
    {merge?.sent && <p role="status">{merge.sent.message} <a href={merge.sent.url} target="_blank" rel="noreferrer">Open Clawson card ↗</a></p>}
    {selected && <div className="ask-action-selection">
      <p>Selected: {selected.instruction}</p>
      <p role="status">{delivery ? statusLabel[delivery.status] : attempt?.rejection ? `Selection not requested: ${attempt.rejection}` : uncertain ? 'Delivery unconfirmed. Retry this selection to check the same request.' : 'Sending selection…'}{delivery?.error ? ` — ${delivery.error}` : ''}</p>
      {delivery?.status === 'answered' && <p className="ask-action-explanation">First Mate replied in this conversation. Read the reply for the outcome.</p>}
      {uncertain && !superseded && <button type="button" className="ask-action-choice" onClick={() => { void select(selected) }}>Retry same selection</button>}
    </div>}
  </div>
}
