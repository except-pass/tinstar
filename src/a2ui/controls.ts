// The interactive-control model over the A2UI schema (KTD2, U2). Runtime-safe:
// no React, no browser globals — imported by the server bundle (esbuild, for the
// answer endpoint's server-side validation) as well as the client bundle (vite,
// for the control components in controls.tsx). This mirrors schema.ts's posture:
// the controls are A2UI *schema* component types the agent declares; only the
// rendering and submit are host-owned, and web_core's action runtime stays
// deferred (see docs/plans/2026-07-17-003-feat-roundup-interactivity-plan.md).
import type { A2uiComponent, A2uiContent } from '../domain/types'

/** The A2UI `component` type strings this slice adds as host-rendered controls.
 *  `Choice` carries a `mode` discriminator (single vs multi); `TextInput` is a
 *  free-text field; `Submit` submits the whole notice form once. */
export const CHOICE_COMPONENT = 'Choice'
export const TEXT_INPUT_COMPONENT = 'TextInput'
export const SUBMIT_COMPONENT = 'Submit'
export const DECISION_COMPONENT = 'Decision'

/** The control component types, so the catalog and the walker can treat them as
 *  a set (they render only inside an interactive form context — U3). */
export const CONTROL_COMPONENTS: ReadonlySet<string> = new Set([
  CHOICE_COMPONENT,
  TEXT_INPUT_COMPONENT,
  SUBMIT_COMPONENT,
  DECISION_COMPONENT,
])

/** Free-text answers are capped so a hostile submit can't bloat the persisted
 *  notice snapshot (defense in depth alongside the API's own recheck, KTD4). */
export const NOTICE_ANSWER_TEXT_MAX = 4000

export interface ChoiceOption {
  id: string
  label: string
}

export interface ParsedChoice {
  /** `single` → radios (one selection); `multi` → checkboxes (any number). */
  mode: 'single' | 'multi'
  options: ChoiceOption[]
}

/** Parse a `Choice` node's agent-authored props into a validated option set, or
 *  `null` when it is malformed (wrong type, no valid options) so the renderer can
 *  degrade it (KTD4/R16) instead of throwing. Options with a non-string or empty
 *  `id`/`label` are dropped; a `Choice` with zero usable options parses to null. */
export function parseChoice(node: A2uiComponent): ParsedChoice | null {
  if (node.component !== CHOICE_COMPONENT) return null
  const raw = node.options
  if (!Array.isArray(raw)) return null
  const options: ChoiceOption[] = []
  for (const o of raw) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const { id, label } = o as { id?: unknown; label?: unknown }
      if (typeof id === 'string' && id !== '' && typeof label === 'string' && label !== '') {
        options.push({ id, label })
      }
    }
  }
  if (options.length === 0) return null
  const mode = node.mode === 'multi' ? 'multi' : 'single'
  return { mode, options }
}

/** True when the notice declares a free-text field the user can fill in (R11). */
export function hasTextInput(content: A2uiContent | undefined | null): boolean {
  return !!content
    && Array.isArray(content.components)
    && content.components.some(n => n?.component === TEXT_INPUT_COMPONENT)
}

/** True when the notice carries any interactive control (a choice, text field, or
 *  submit) — i.e. it is answerable from the widget rather than headline/prose only. */
export function isAnswerable(content: A2uiContent | undefined | null): boolean {
  return !!content
    && Array.isArray(content.components)
    && content.components.some(n => typeof n?.component === 'string' && CONTROL_COMPONENTS.has(n.component))
}

/** The universe of choice option ids a notice declares — the single source of
 *  truth the answer endpoint validates a submitted `choices[]` against (KTD4:
 *  a submitted id not in this set is rejected, nothing persisted). Scans the flat
 *  component list, which is a safe superset of what the walker renders. */
export function collectChoiceOptionIds(content: A2uiContent | undefined | null): Set<string> {
  const ids = new Set<string>()
  if (!content || !Array.isArray(content.components)) return ids
  for (const node of content.components) {
    const choice = parseChoice(node)
    if (choice) for (const o of choice.options) ids.add(o.id)
    const decision = parseDecision(node)
    if (decision) for (const o of decision.options) ids.add(o.id)
  }
  return ids
}

/** option id → human label, so a delivered answer prompt can name the chosen
 *  option in words instead of an opaque id. Last declaration of an id wins. */
export function collectChoiceOptionLabels(content: A2uiContent | undefined | null): Map<string, string> {
  const labels = new Map<string, string>()
  if (!content || !Array.isArray(content.components)) return labels
  for (const node of content.components) {
    const choice = parseChoice(node)
    if (choice) for (const o of choice.options) labels.set(o.id, o.label)
    const decision = parseDecision(node)
    if (decision) for (const o of decision.options) labels.set(o.id, o.label)
  }
  return labels
}

// ---------------------------------------------------------------------------
// Decision — one open decision, with its tradeoffs, risks, cost to undo, and
// horizon. A CONTROL, not a display block: its options are the single
// declaration feeding both the rendered radios and the server's answer
// validation, so an author cannot let the pick and the reasoning drift apart.
//
// Two corrections to FMEA are baked into the scales below. First, every scale
// runs fine → alarming left to right, including `discoverability` — FMEA's
// "detection" reads as a virtue while its rating runs bad-upward, so a reader
// has to translate every cell. Second, nothing here multiplies into a composite:
// these are ordinal scales, and an RPN-style product of ordinals is arithmetic
// on labels. The reader reads the cells.
// ---------------------------------------------------------------------------

/** Hard caps, for the same reason `Stepper` has MAX_STEPS: one node expands into
 *  many rows, and the renderer's node budget counts components. The catalog's
 *  `cost` hook charges these rows to the per-surface budget. */
export const MAX_DECISION_OPTIONS = 8
export const MAX_DECISION_RISKS = 12

export const SEVERITY_SCALE = ['annoying', 'costly', 'severe'] as const
export const LIKELIHOOD_SCALE = ['unlikely', 'possible', 'likely'] as const
export const DISCOVERABILITY_SCALE = ['obvious', 'subtle', 'silent'] as const
export const REVERSAL_ACTION_SCALE = ['trivial', 'cheap', 'costly', 'one-way'] as const
export const REVERSAL_DAMAGE_SCALE = ['minutes', 'hours', 'days', 'weeks+'] as const
export const HORIZON_SCALE = ['until-next-commit', 'until-this-ships', 'while-the-code-lives', 'permanent'] as const

/** A scored dimension. `heat` is an ordinal 0–3 intensity on a shared ramp — NOT
 *  a color; the render layer owns that mapping. `heat: null` means the host does
 *  not recognise the word: render it verbatim and uncolored, never coerced to a
 *  known value. Coercing down would silently understate a risk and coercing up
 *  would cry wolf, which is why this differs from Stepper's unknown → `pending`
 *  (a neutral default is safe for progress and unsafe for risk). */
export interface Rating {
  value: string
  heat: number | null
}

/** Rate a raw prop against its scale. `null` = absent (draw nothing), which is a
 *  different thing from unrecognised (draw the word, don't color it).
 *  A 3-step scale stretches onto the 4-step ramp as 0/2/3 so its top step is as
 *  hot as a 4-step scale's; a 4-step scale maps straight through. */
function rate(raw: unknown, scale: readonly string[]): Rating | null {
  if (typeof raw !== 'string' || raw === '') return null
  const i = scale.indexOf(raw)
  if (i === -1) return { value: raw, heat: null }
  return { value: raw, heat: scale.length === 3 ? [0, 2, 3][i]! : i }
}

/** Read an optional prose prop, coercing anything non-string to ''. */
function prose(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

export interface DecisionOption {
  id: string
  label: string
  /** What you get. */
  gain: string
  /** What you give up — concrete, not "more complexity". */
  cost: string
  /** The condition that would flip the call. */
  wrongIf: string
}

export interface DecisionRisk {
  label: string
  severity: Rating | null
  likelihood: Rating | null
  discoverability: Rating | null
  note: string
}

export interface DecisionReversal {
  /** How long to undo the ACTION. */
  action: Rating | null
  /** How long to undo the DAMAGE — routinely a very different number. */
  damage: Rating | null
  note: string
}

export interface DecisionHorizon {
  span: Rating | null
  /** What ends it, phrased to complete "this matters until…". Required whenever
   *  `span` is present: it is the field that forces the author to say out loud
   *  what survives an undo. */
  until: string
}

export interface ParsedDecision {
  options: DecisionOption[]
  /** Raw `options` entries never examined because MAX_DECISION_OPTIONS was hit
   *  (0 when nothing was cut). Mirrors Stepper's `hidden` — an upper bound on the
   *  loss, not a claim about what those entries would have parsed to. Unlike
   *  Stepper, Decision has exactly one truncation cause (the hard row cap), so
   *  there is no second "scan window" story to distinguish. */
  hiddenOptions: number
  risks: DecisionRisk[]
  /** The author declared risks and none survived → show the inline notice. */
  risksMalformed: boolean
  /** Raw `risks` entries never examined because MAX_DECISION_RISKS was hit. */
  hiddenRisks: number
  reversal: DecisionReversal | null
  reversalMalformed: boolean
  horizon: DecisionHorizon | null
  horizonMalformed: boolean
  comment: { label: string; placeholder: string }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** `hidden` is `raw.length - i`, i.e. the count of raw entries the loop never
 *  reached because MAX_DECISION_OPTIONS was already full — the same "entries
 *  never examined" accounting parseSteps uses, minus the scan-window half of
 *  that story (Decision has no second cap to distinguish). */
function parseOptions(raw: unknown): { options: DecisionOption[]; hidden: number } {
  if (!Array.isArray(raw)) return { options: [], hidden: 0 }
  const out: DecisionOption[] = []
  let i = 0
  for (; i < raw.length; i++) {
    if (out.length >= MAX_DECISION_OPTIONS) break
    const o: unknown = raw[i]
    if (!isRecord(o)) continue
    const { id, label } = o
    if (typeof id !== 'string' || id === '') continue
    if (typeof label !== 'string' || label === '') continue
    out.push({ id, label, gain: prose(o.gain), cost: prose(o.cost), wrongIf: prose(o.wrongIf) })
  }
  return { options: out, hidden: raw.length - i }
}

function parseRisks(raw: unknown): { risks: DecisionRisk[]; malformed: boolean; hidden: number } {
  if (raw === undefined || raw === null) return { risks: [], malformed: false, hidden: 0 }
  if (!Array.isArray(raw)) return { risks: [], malformed: true, hidden: 0 }
  const risks: DecisionRisk[] = []
  let i = 0
  for (; i < raw.length; i++) {
    if (risks.length >= MAX_DECISION_RISKS) break
    const r: unknown = raw[i]
    if (!isRecord(r)) continue
    const label = r.label
    if (typeof label !== 'string' || label === '') continue
    risks.push({
      label,
      severity: rate(r.severity, SEVERITY_SCALE),
      likelihood: rate(r.likelihood, LIKELIHOOD_SCALE),
      discoverability: rate(r.discoverability, DISCOVERABILITY_SCALE),
      note: prose(r.note),
    })
  }
  // An author who declared risks and got none rendered needs to be told; an
  // author who declared none is simply not using the block.
  return { risks, malformed: risks.length === 0 && raw.length > 0, hidden: raw.length - i }
}

function parseReversal(raw: unknown): { reversal: DecisionReversal | null; malformed: boolean } {
  if (raw === undefined || raw === null) return { reversal: null, malformed: false }
  if (!isRecord(raw)) return { reversal: null, malformed: true }
  const action = rate(raw.action, REVERSAL_ACTION_SCALE)
  const damage = rate(raw.damage, REVERSAL_DAMAGE_SCALE)
  // A note with no ratings is prose pretending to be a block — the reversal
  // section exists to state two numbers.
  if (!action && !damage) return { reversal: null, malformed: true }
  return { reversal: { action, damage, note: prose(raw.note) }, malformed: false }
}

function parseHorizon(raw: unknown): { horizon: DecisionHorizon | null; malformed: boolean } {
  if (raw === undefined || raw === null) return { horizon: null, malformed: false }
  if (!isRecord(raw)) return { horizon: null, malformed: true }
  const span = rate(raw.span, HORIZON_SCALE)
  const until = prose(raw.until)
  if (!span || until === '') return { horizon: null, malformed: true }
  return { horizon: { span, until }, malformed: false }
}

function parseComment(raw: unknown): { label: string; placeholder: string } {
  const fallback = { label: 'Anything else?', placeholder: '' }
  if (!isRecord(raw)) return fallback
  return {
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : fallback.label,
    placeholder: prose(raw.placeholder),
  }
}

/** Parse a `Decision` node, or `null` when it is not a decision at all — a wrong
 *  component type, or fewer than two usable options (one option is not a
 *  decision). A malformed *block* never returns null: risks, reversal, and
 *  horizon each degrade on their own so a typo in one cannot hide the options. */
export function parseDecision(node: A2uiComponent): ParsedDecision | null {
  if (node.component !== DECISION_COMPONENT) return null
  const { options, hidden: hiddenOptions } = parseOptions(node.options)
  if (options.length < 2) return null
  const { risks, malformed: risksMalformed, hidden: hiddenRisks } = parseRisks(node.risks)
  const { reversal, malformed: reversalMalformed } = parseReversal(node.reversal)
  const { horizon, malformed: horizonMalformed } = parseHorizon(node.horizon)
  return {
    options,
    hiddenOptions,
    risks,
    risksMalformed,
    hiddenRisks,
    reversal,
    reversalMalformed,
    horizon,
    horizonMalformed,
    comment: parseComment(node.comment),
  }
}
