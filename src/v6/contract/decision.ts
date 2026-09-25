import { isRecord, parsed, rejected, requiredString, type ParseResult } from './result'

/**
 * Decision scales, reimplemented from the V5 control model.
 * Unknown words stay unknown. Nothing here becomes a composite score.
 */
export const MAX_DECISION_OPTIONS = 8
export const MAX_DECISION_RISKS = 12

export const SEVERITY_SCALE = ['annoying', 'costly', 'severe'] as const
export const LIKELIHOOD_SCALE = ['unlikely', 'possible', 'likely'] as const
export const DISCOVERABILITY_SCALE = ['obvious', 'subtle', 'silent'] as const
export const REVERSAL_ACTION_SCALE = ['trivial', 'cheap', 'costly', 'one-way'] as const
export const REVERSAL_DAMAGE_SCALE = ['minutes', 'hours', 'days', 'weeks+'] as const
export const HORIZON_SCALE = ['until-next-commit', 'until-this-ships', 'while-the-code-lives', 'permanent'] as const

export type Severity = (typeof SEVERITY_SCALE)[number]
export type Likelihood = (typeof LIKELIHOOD_SCALE)[number]
export type Discoverability = (typeof DISCOVERABILITY_SCALE)[number]
export type ReversalAction = (typeof REVERSAL_ACTION_SCALE)[number]
export type ReversalDamage = (typeof REVERSAL_DAMAGE_SCALE)[number]
export type HorizonSpan = (typeof HORIZON_SCALE)[number]

/** A scale word as written. `known: false` is not coerced onto the scale. */
export interface ScaleWord {
  value: string
  known: boolean
}

export interface DecisionOption {
  id: string
  label: string
  gain: string
  cost: string
  wrongIf: string
}

export interface DecisionRisk {
  label: string
  severity: ScaleWord | null
  likelihood: ScaleWord | null
  discoverability: ScaleWord | null
  note?: string
}

export interface DecisionReversal {
  action: ScaleWord | null
  damage: ScaleWord | null
  note?: string
}

export interface DecisionHorizon {
  span: ScaleWord | null
  /** What ends it. Required when `span` is present. */
  until: string
}

export interface DecisionPayload {
  options: DecisionOption[]
  risks: DecisionRisk[]
  reversal: DecisionReversal
  horizon: DecisionHorizon
  /** Comment is always available. Empty string means the author left it blank. */
  comment: string
}

export function rateScaleWord(raw: unknown, scale: readonly string[]): ParseResult<ScaleWord | null> {
  if (raw === undefined || raw === null || raw === '') return parsed(null)
  if (typeof raw !== 'string') return rejected('scale word must be a string')
  return parsed({ value: raw, known: scale.includes(raw) })
}

function parseOption(raw: unknown, index: number): ParseResult<DecisionOption> {
  if (!isRecord(raw)) return rejected(`options[${index}] must be an object`)
  const id = requiredString(raw.id, `options[${index}].id`)
  if (!id.ok) return id
  const label = requiredString(raw.label, `options[${index}].label`)
  if (!label.ok) return label
  for (const key of ['gain', 'cost', 'wrongIf'] as const) {
    if (typeof raw[key] !== 'string') return rejected(`options[${index}].${key} must be a string`)
  }
  return parsed({
    id: id.value,
    label: label.value,
    gain: raw.gain as string,
    cost: raw.cost as string,
    wrongIf: raw.wrongIf as string,
  })
}

function parseRisk(raw: unknown, index: number): ParseResult<DecisionRisk> {
  if (!isRecord(raw)) return rejected(`risks[${index}] must be an object`)
  const label = requiredString(raw.label, `risks[${index}].label`)
  if (!label.ok) return label
  const severity = rateScaleWord(raw.severity, SEVERITY_SCALE)
  if (!severity.ok) return severity
  const likelihood = rateScaleWord(raw.likelihood, LIKELIHOOD_SCALE)
  if (!likelihood.ok) return likelihood
  const discoverability = rateScaleWord(raw.discoverability, DISCOVERABILITY_SCALE)
  if (!discoverability.ok) return discoverability
  if (raw.note !== undefined && typeof raw.note !== 'string') {
    return rejected(`risks[${index}].note must be a string`)
  }
  const risk: DecisionRisk = {
    label: label.value,
    severity: severity.value,
    likelihood: likelihood.value,
    discoverability: discoverability.value,
  }
  if (typeof raw.note === 'string') risk.note = raw.note
  return parsed(risk)
}

export function parseDecisionPayload(raw: unknown): ParseResult<DecisionPayload> {
  if (!isRecord(raw)) return rejected('decision payload must be an object')
  if (!Array.isArray(raw.options)) return rejected('options must be an array')
  if (raw.options.length < 2) return rejected('a decision needs at least two options')
  if (raw.options.length > MAX_DECISION_OPTIONS) {
    return rejected(`a decision accepts at most ${MAX_DECISION_OPTIONS} options`)
  }
  const options: DecisionOption[] = []
  for (let i = 0; i < raw.options.length; i++) {
    const option = parseOption(raw.options[i], i)
    if (!option.ok) return option
    options.push(option.value)
  }
  const riskRaw = raw.risks === undefined ? [] : raw.risks
  if (!Array.isArray(riskRaw)) return rejected('risks must be an array')
  if (riskRaw.length > MAX_DECISION_RISKS) {
    return rejected(`a decision accepts at most ${MAX_DECISION_RISKS} risks`)
  }
  const risks: DecisionRisk[] = []
  for (let i = 0; i < riskRaw.length; i++) {
    const risk = parseRisk(riskRaw[i], i)
    if (!risk.ok) return risk
    risks.push(risk.value)
  }
  const reversalRaw = isRecord(raw.reversal) ? raw.reversal : {}
  const action = rateScaleWord(reversalRaw.action, REVERSAL_ACTION_SCALE)
  if (!action.ok) return action
  const damage = rateScaleWord(reversalRaw.damage, REVERSAL_DAMAGE_SCALE)
  if (!damage.ok) return damage
  if (reversalRaw.note !== undefined && typeof reversalRaw.note !== 'string') {
    return rejected('reversal.note must be a string')
  }
  const horizonRaw = isRecord(raw.horizon) ? raw.horizon : {}
  const span = rateScaleWord(horizonRaw.span, HORIZON_SCALE)
  if (!span.ok) return span
  if (span.value && typeof horizonRaw.until !== 'string') {
    return rejected('horizon.until is required when horizon.span is set')
  }
  if (horizonRaw.until !== undefined && typeof horizonRaw.until !== 'string') {
    return rejected('horizon.until must be a string')
  }
  if (raw.comment !== undefined && typeof raw.comment !== 'string') {
    return rejected('comment must be a string')
  }
  const reversal: DecisionReversal = { action: action.value, damage: damage.value }
  if (typeof reversalRaw.note === 'string') reversal.note = reversalRaw.note
  return parsed({
    options,
    risks,
    reversal,
    horizon: { span: span.value, until: typeof horizonRaw.until === 'string' ? horizonRaw.until : '' },
    comment: typeof raw.comment === 'string' ? raw.comment : '',
  })
}
