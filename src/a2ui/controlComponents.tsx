// Host-rendered interactive controls (U2/U3) with host-managed form state (KTD2).
//
// The controls are A2UI component types the agent *declares* (parsed by the
// runtime-safe controls.ts); here we render them as Tinstar Tailwind form
// controls and read/write their value through a host-owned React context — NOT
// web_core's data model or its client-to-server action runtime, which stay
// deferred. When no interactive form context is present (a control rendered
// read-only, e.g. a headline preview), the default context renders the controls
// disabled/static so nothing is ever half-wired.
import { createContext, useContext, type ReactNode } from 'react'
import type { A2uiComponent } from '../domain/types'
import { parseChoice, parseDecision, type DecisionRisk, type Rating } from './controls'
import type { FollowUpPreset } from './followUps'

/** Shared textarea styling for every free-text control (`TextInput`, and
 *  `Decision`'s comment box) — a single literal class string so Tailwind's JIT
 *  and `eslint-rules/valid-theme-classnames.js` see it whole, and so the two
 *  controls can never drift apart in how a text field looks. */
const TEXTAREA_CLASS =
  'w-full rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-500 focus:outline-none disabled:opacity-70'

/** The host-owned form state for one notice. Held by the widget's NoticeCard
 *  (U3); the control components below read and mutate it through context. */
export interface NoticeFormState {
  /** False in a read-only render (no provider) → every control is disabled. */
  interactive: boolean
  /** The notice has been answered (optimistically or from the server). Controls
   *  lock and the submit shows a confirmation. */
  answered: boolean
  /** A submit is in flight — guards double-submit and shows a pending label. */
  submitting: boolean
  /** Selected option ids for ONE choice component, keyed by the choice's id. Each
   *  Choice group is independent, so two groups in a notice don't clobber each
   *  other (a single-select in one group doesn't wipe the other's selection). */
  selectedFor(choiceId: string): ReadonlySet<string>
  /** Current free-text value. */
  text: string
  toggleOption(choiceId: string, optionId: string, mode: 'single' | 'multi'): void
  setText(value: string): void
  submit(): void
}

/** The read-only default: no provider ⇒ controls render disabled and inert. */
const READ_ONLY_FORM: NoticeFormState = {
  interactive: false,
  answered: false,
  submitting: false,
  selectedFor: () => new Set(),
  text: '',
  toggleOption: () => {},
  setText: () => {},
  submit: () => {},
}

const NoticeFormContext = createContext<NoticeFormState>(READ_ONLY_FORM)

/** Provide the interactive form state to the controls rendered beneath it. */
export function NoticeFormProvider({ value, children }: { value: NoticeFormState; children: ReactNode }): ReactNode {
  return <NoticeFormContext.Provider value={value}>{children}</NoticeFormContext.Provider>
}

/** Read the current notice form state (the read-only default outside a provider). */
export function useNoticeForm(): NoticeFormState {
  return useContext(NoticeFormContext)
}

/** A malformed control degrades to this amber inline marker (never a throw),
 *  matching the walker's NodeFallback styling (R16/KTD4). */
function ControlFallback({ label }: { label: string }): ReactNode {
  return <span className="text-xs italic text-amber-300/80">⚠ {label}</span>
}

/** A single- or multi-select choice (R10). Radios for `single`, checkboxes for
 *  `multi`. Options and mode are agent-declared; the selection is host-owned. */
export function ChoiceControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const parsed = parseChoice(node)
  if (!parsed) return <ControlFallback label="choice has no options" />
  const disabled = !form.interactive || form.answered || form.submitting
  const multi = parsed.mode === 'multi'
  // The choice's own id keys its selection so multiple choice groups on one notice
  // stay independent. Radios also need a unique `name` per group to be mutually
  // exclusive within the group but not across groups.
  const choiceId = typeof node.id === 'string' && node.id ? node.id : ''
  const groupName = `choice-${choiceId || 'default'}`
  const selected = form.selectedFor(choiceId)
  return (
    <div className="flex flex-col gap-1 my-1.5" role={multi ? 'group' : 'radiogroup'}>
      {parsed.options.map(opt => (
        <label
          key={opt.id}
          className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-70' : 'cursor-pointer'}`}
        >
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={groupName}
            value={opt.id}
            checked={selected.has(opt.id)}
            disabled={disabled}
            onChange={() => form.toggleOption(choiceId, opt.id, parsed.mode)}
            className="mt-0.5 accent-amber-500"
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  )
}

/** A free-text field (R11), available with or without a choice set. */
export function TextInputControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const label = typeof node.label === 'string' ? node.label : ''
  const placeholder = typeof node.placeholder === 'string' ? node.placeholder : ''
  const disabled = !form.interactive || form.answered || form.submitting
  return (
    <div className="flex flex-col gap-1 my-1.5">
      {label && <span className="text-xs text-neutral-400">{label}</span>}
      <textarea
        rows={3}
        value={form.text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => form.setText(e.target.value)}
        className={TEXTAREA_CLASS}
      />
    </div>
  )
}

/** One ask chip in a notice's follow-up panel. Host-themed like every other control
 *  here, and rendered from a validated `FollowUpPreset` — the label is agent-authored
 *  text and nothing else, with no url/href anywhere on the component, so a chip can
 *  never become a navigation vector. */
export function FollowUpChip({ preset, disabled, onAsk }: {
  preset: FollowUpPreset
  disabled: boolean
  onAsk: (preset: FollowUpPreset) => void
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={`followup-chip-${preset.id}`}
      title={preset.question}
      disabled={disabled}
      onClick={() => onAsk(preset)}
      className="rounded-full border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-amber-500 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {preset.label}
    </button>
  )
}

/** The submit control. Once answered it flips to a confirmation (R23); the widget
 *  disables it while a submit is in flight to prevent a double-submit. */
export function SubmitControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const label = typeof node.label === 'string' && node.label.trim() ? node.label : 'Submit'
  if (form.answered) {
    return <div className="my-1.5 text-sm font-medium text-emerald-300">✓ Answered</div>
  }
  return (
    <button
      type="button"
      onClick={() => form.submit()}
      disabled={!form.interactive || form.submitting}
      className="my-1.5 self-start rounded bg-amber-500 px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {form.submitting ? 'Submitting…' : label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Decision — one open decision, rendered as a card (Slate, 2026-08-06).
//
// A control, not a prose block: the radios and the tradeoff text come from ONE
// options declaration, so what the user picks and what they read about it can
// never drift. Selection is keyed by the Decision node's own id, exactly as a
// Choice group is, so the two coexist on one surface without clobbering.
// ---------------------------------------------------------------------------

// One tone per heat step, LITERAL class strings so Tailwind's JIT emits them
// (same discipline as catalog.tsx's STEP_NODE). The ramp is a single amber
// INTENSITY, not a hue shift: the palette reserves red for a failed action, and
// the only meaning color carries here is "this end is the dangerous one". The
// label beside the chip is what distinguishes one dimension from another.
const HEAT: readonly string[] = [
  'border-hairline bg-surface-hover text-ink-low',
  'border-hairline bg-surface-hover text-ink-mid',
  'border-hue-discussing/22 bg-hue-discussing/10 text-hue-discussing',
  'border-hue-discussing/40 bg-hue-discussing/20 text-hue-discussing',
]

// An unrecognised word is shown, never rated — so it gets the quietest tone and
// no amber at all. Coercing it either way would lie about a risk (R8).
const HEAT_UNKNOWN = 'border-hairline bg-surface-hover text-ink-low'

// The one cross-field emphasis on the card: a risk nothing will alert on,
// attached to a decision that never stops mattering. Brighter than heat 3, and
// deliberately NOT a score — nothing is computed, sorted, or thresholded on it.
const HEAT_FLARE = 'border-hue-discussing/60 bg-hue-discussing/25 text-hue-discussing'

/** One `label VALUE` pair. Mono throughout — a rating is meta, not prose. `flare`
 *  is a visual-only brightness bump (see DecisionControl's `flareFor`); the
 *  `data-flare` attribute is not a second source of meaning for sighted users —
 *  `data-heat` already carries the underlying rating unchanged, so nothing is
 *  lost if flare is ignored. Reserving an sr-only word for it (as the option
 *  gain/cost/wrong-if lines do) would announce a color-only judgment call as if
 *  it were an independent fact, which is exactly the composite-score framing
 *  this task is forbidden from introducing. */
function RatingChip({ label, rating, flare = false }: { label: string; rating: Rating | null; flare?: boolean }): ReactNode {
  if (!rating) return null
  const tone = rating.heat === null ? HEAT_UNKNOWN : flare ? HEAT_FLARE : HEAT[rating.heat]
  return (
    <span
      className="inline-flex items-baseline gap-1.5"
      data-testid={`decision-rating-${label}`}
      data-heat={rating.heat === null ? 'unknown' : String(rating.heat)}
      {...(flare ? { 'data-flare': 'true' } : {})}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-low">{label}</span>
      <span className={`font-mono text-[10px] uppercase tracking-[0.08em] rounded-[3px] border px-1.5 py-px ${tone}`}>
        {rating.value}
      </span>
    </span>
  )
}

/** A section label — the mono caps meta ramp shared with Text's h4/h5. */
function SectionLabel({ text }: { text: string }): ReactNode {
  return <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-low mt-2 mb-1">{text}</div>
}

/** Authored prose inside the card. `font-sans` is load-bearing: the run card
 *  defaults to mono, so an unpinned sentence renders as terminal output. */
function Prose({ text, testId }: { text: string; testId?: string }): ReactNode {
  if (!text) return null
  return <div className="font-sans text-[12.5px] leading-[1.5] text-ink-low" data-testid={testId}>{text}</div>
}

export function DecisionControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const parsed = parseDecision(node)
  if (!parsed) return <ControlFallback label="decision needs at least two options" />
  const disabled = !form.interactive || form.answered || form.submitting
  const choiceId = typeof node.id === 'string' && node.id ? node.id : ''
  const selected = form.selectedFor(choiceId)
  const { options, risks, risksMalformed, reversal, reversalMalformed, horizon, horizonMalformed, comment } = parsed
  // Emphasis, not a score: the combination the reader most needs to catch.
  const permanent = horizon?.span?.value === 'permanent'
  const flareFor = (risk: DecisionRisk) => permanent && risk.discoverability?.value === 'silent'

  return (
    <div className="flex flex-col my-1" data-testid="decision">
      <SectionLabel text="Options" />
      <div className="flex flex-col gap-2" role="radiogroup">
        {options.map(opt => (
          <label key={opt.id} className={`flex items-start gap-2 ${disabled ? 'opacity-70' : 'cursor-pointer'}`}>
            <input
              type="radio"
              name={`decision-${choiceId || 'default'}`}
              value={opt.id}
              checked={selected.has(opt.id)}
              disabled={disabled}
              onChange={() => form.toggleOption(choiceId, opt.id, 'single')}
              className="mt-1 accent-amber-500"
            />
            <span className="min-w-0">
              <span className="font-sans text-[13px] leading-[1.4] text-ink-high block">{opt.label}</span>
              {/* The glyph is decorative (aria-hidden); an sr-only word carries the same
                  distinction to assistive tech, matching StepperRail's status-text pattern
                  (catalog.tsx) — without it, gain/cost/wrong-if read as three indistinguishable
                  plain lines to a screen reader. */}
              {opt.gain && (
                <span className="font-sans text-[12.5px] leading-[1.5] text-ink-mid block">
                  <span aria-hidden="true">{'+ '}</span>
                  <span className="sr-only">{'gain: '}</span>
                  {opt.gain}
                </span>
              )}
              {opt.cost && (
                <span className="font-sans text-[12.5px] leading-[1.5] text-ink-mid block">
                  <span aria-hidden="true">{'− '}</span>
                  <span className="sr-only">{'cost: '}</span>
                  {opt.cost}
                </span>
              )}
              {opt.wrongIf && (
                <span className="font-sans text-[12.5px] leading-[1.5] text-ink-low block">
                  <span aria-hidden="true">{'⚑ wrong if '}</span>
                  <span className="sr-only">{'wrong if: '}</span>
                  {opt.wrongIf}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {(risks.length > 0 || risksMalformed) && <SectionLabel text="Risks" />}
      {risksMalformed && <span className="text-xs italic text-amber-300/80" data-testid="decision-risks-fallback">⚠ decision: no readable risks</span>}
      {risks.map((risk, i) => (
        <div key={`${i}-${risk.label}`} className="flex flex-col gap-0.5 mb-2" data-testid="decision-risk">
          <div className="font-sans text-[13px] leading-[1.4] text-ink-high">{risk.label}</div>
          <div className="flex flex-row flex-wrap gap-x-3 gap-y-1">
            <RatingChip label="severity" rating={risk.severity} />
            <RatingChip label="likelihood" rating={risk.likelihood} />
            <RatingChip label="discoverability" rating={risk.discoverability} flare={flareFor(risk)} />
          </div>
          <Prose text={risk.note} />
        </div>
      ))}

      {(reversal || reversalMalformed) && <SectionLabel text="Reversal" />}
      {reversalMalformed && <span className="text-xs italic text-amber-300/80" data-testid="decision-reversal-fallback">⚠ decision: reversal needs how long to undo the action or the damage</span>}
      {reversal && (
        <div className="flex flex-col gap-0.5 mb-2">
          <div className="flex flex-row flex-wrap gap-x-3 gap-y-1">
            <RatingChip label="action" rating={reversal.action} />
            <RatingChip label="damage" rating={reversal.damage} />
          </div>
          <Prose text={reversal.note} />
        </div>
      )}

      {(horizon || horizonMalformed) && <SectionLabel text="Horizon" />}
      {horizonMalformed && <span className="text-xs italic text-amber-300/80" data-testid="decision-horizon-fallback">⚠ decision: horizon needs a span and an `until`</span>}
      {horizon && (
        <div className="flex flex-col gap-0.5 mb-2">
          <RatingChip label="span" rating={horizon.span} flare={risks.some(flareFor)} />
          <Prose text={`until: ${horizon.until}`} testId="decision-until" />
        </div>
      )}

      {/* The comment box is not optional (R7) — the user always has somewhere to
          say the thing the options did not anticipate. It binds to the point's
          single shared `text` field, which is why this needs no endpoint change.
          Consequence: a sibling TextInput on the same surface would be a second
          box writing this same string. */}
      <div className="flex flex-col gap-1 mt-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-low">{comment.label}</span>
        <textarea
          rows={3}
          value={form.text}
          placeholder={comment.placeholder}
          disabled={disabled}
          onChange={e => form.setText(e.target.value)}
          data-testid="decision-comment"
          className={TEXTAREA_CLASS}
        />
      </div>
    </div>
  )
}
