import { useState } from 'react'
import type { DecisionPayload, ScaleWord } from '../contract/decision'
import { scaleText } from './model'
import { CardIdentity, cardAttrs, useAnswerState, type AttentionCommit } from './useAnswerState'
import type { AttentionRow } from './model'

function ScaleLine({ word, label, testId }: { word: ScaleWord | null; label: string; testId: string }) {
  const shown = scaleText(word, label)
  return (
    <span data-testid={testId} data-known={shown.known === null ? 'absent' : String(shown.known)}>
      {shown.text}
    </span>
  )
}

/** Decision card: option buttons on the rail, full scales only after Details. */
export function DecisionCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  const { view, pending, error, open, setOpen, run } = useAnswerState(row, commit)
  const payload = view.item.payload as DecisionPayload
  const [comment, setComment] = useState(payload.comment)
  const cue = payload.risks[0]
  const horizon = payload.horizon.span
  return (
    <article {...cardAttrs(view, pending, 'DecisionCard')}>
      <CardIdentity row={view} pending={pending} />
      <div data-region="options" className="flex flex-col gap-1">
        {payload.options.map(option => (
          <button
            key={option.id}
            type="button"
            data-action="choose"
            data-option={option.id}
            disabled={pending}
            className="text-left text-ink-high"
            onClick={() => void run('attention.answer', { optionId: option.id, comment }, `option:${option.id}`)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p data-region="cue">
        {cue ? cue.label : 'no risk cue'}
        {horizon ? ` · horizon ${horizon.value}` : ''}
      </p>
      <div data-region="primary">
        <button type="button" data-action="details" aria-expanded={open} onClick={() => setOpen(!open)}>
          Details
        </button>
      </div>
      {open ? (
        <div data-testid={`decision-expanded-${view.item.id}`}>
          {payload.options.map(option => (
            <div key={option.id}>
              <p data-testid={`option-${view.item.id}-${option.id}-gain`}>gain: {option.gain}</p>
              <p data-testid={`option-${view.item.id}-${option.id}-cost`}>cost: {option.cost}</p>
              <p data-testid={`option-${view.item.id}-${option.id}-wrongIf`}>wrongIf: {option.wrongIf}</p>
            </div>
          ))}
          {payload.risks.map((risk, index) => (
            <div key={`${risk.label}-${index}`} data-testid={`decision-risk-${view.item.id}-${index}`}>
              <p>{risk.label}</p>
              <ScaleLine word={risk.severity} label="severity" testId={`risk-${view.item.id}-${index}-severity`} />
              <ScaleLine word={risk.likelihood} label="likelihood" testId={`risk-${view.item.id}-${index}-likelihood`} />
              <ScaleLine word={risk.discoverability} label="discoverability" testId={`risk-${view.item.id}-${index}-discoverability`} />
            </div>
          ))}
          <ScaleLine word={payload.reversal.action} label="reversal action" testId={`reversal-action-${view.item.id}`} />
          <ScaleLine word={payload.reversal.damage} label="reversal damage" testId={`reversal-damage-${view.item.id}`} />
          <ScaleLine word={payload.horizon.span} label="horizon span" testId={`horizon-span-${view.item.id}`} />
          <p data-testid={`horizon-until-${view.item.id}`}>until: {payload.horizon.until}</p>
          <label>
            Comment
            <textarea
              data-testid={`decision-comment-${view.item.id}`}
              value={comment}
              onChange={event => setComment(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      {error ? <p data-testid={`needsyou-error-${view.item.id}`} role="alert">{error}</p> : null}
    </article>
  )
}
