import { useRef, useState } from 'react'
import type { AskAction, AskSuggestion } from '../shared/ask-actions'
import './ask-actions.css'

/** Adapter boundary for Chunk 1's selected conversation turn. No browser prose
 * enters the selection request; the store must resolve the retained instruction.
 */
export interface AskActionSelectionInput {
  answer_id: string
  action_id: string
  client_key: string
}
export interface AskActionDelivery {
  status: 'sent' | 'delivered' | 'answered' | 'failed'
  error?: string | null
}
export interface AskActionSelection extends AskActionDelivery { action_id: string }
export interface AskActionsProps {
  answerId: string
  suggestions: AskSuggestion[]
  superseded: boolean
  selection?: AskActionSelection | null
  onSelect: (input: AskActionSelectionInput) => Promise<AskActionDelivery>
}
const statusLabel = { sent: 'Requested', delivered: 'Delivered', answered: 'Answered', failed: 'Failed' } as const
interface Attempt { input: AskActionSelectionInput; delivery?: AskActionDelivery; uncertain?: boolean }

export function AskActions(props: AskActionsProps) {
  // Changing the answer resets only local presentation, never a retained turn.
  return <ActionChoices key={props.answerId} {...props} />
}

function ActionChoices({ answerId, suggestions, superseded, selection, onSelect }: AskActionsProps) {
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const locked = useRef(false)
  const attemptRef = useRef<Attempt | null>(null)
  const actions = suggestions.filter((suggestion): suggestion is AskAction => typeof suggestion !== 'string')
  const legacy = suggestions.filter((suggestion): suggestion is string => typeof suggestion === 'string')
  const selectedId = selection?.action_id ?? attempt?.input.action_id
  const selected = actions.find(action => action.id === selectedId)
  const delivery = selection ?? attempt?.delivery
  const uncertain = !selection && attempt?.uncertain
  const unavailable = superseded || !!selectedId

  async function select(action: AskAction) {
    // The ref closes the same-event double-click window before React rerenders.
    // Unknown acknowledgements keep the key and chosen action for reconciliation.
    if (locked.current || superseded || selection || attemptRef.current && attemptRef.current.input.action_id !== action.id) return
    if (attemptRef.current && !attemptRef.current.uncertain) return
    locked.current = true
    const current: Attempt = { input: attemptRef.current?.input ?? { answer_id: answerId, action_id: action.id, client_key: crypto.randomUUID() } }
    attemptRef.current = current
    setAttempt(current)
    try {
      const next = { ...current, delivery: await onSelect(current.input) }
      attemptRef.current = next
      setAttempt(next)
    } catch {
      // A lost response does not prove that the server rejected the selection.
      const next = { ...current, uncertain: true }
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
    {selected && <div className="ask-action-selection">
      <p>Selected: {selected.instruction}</p>
      <p role="status">{delivery ? statusLabel[delivery.status] : uncertain ? 'Delivery unconfirmed. Retry this selection to check the same request.' : 'Sending selection…'}{delivery?.error ? ` — ${delivery.error}` : ''}</p>
      {delivery?.status === 'answered' && <p className="ask-action-explanation">First Mate replied in this conversation. Read the reply for the outcome.</p>}
      {uncertain && !superseded && <button type="button" className="ask-action-choice" onClick={() => { void select(selected) }}>Retry same selection</button>}
    </div>}
  </div>
}
