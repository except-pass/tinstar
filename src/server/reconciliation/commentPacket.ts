import { decisionPacketSchema, type DecisionEvidence, type DecisionPacket, type DecisionRequestEvidence } from '../../shared/decisionPacket'
import type { CardContextRead } from './cardContext'

export const commentPacketSource = 'card comment (default authorization)'
export const commentPacketAuthorization = 'Default for comment-imported packets: your answer is recorded on the card and routed to the owning mate (Owner Firstmate, Status Queued); nothing else changes until they act.'
export const commentPacketActor = `Tinstar Decision Prep · ${commentPacketSource}`
type Comment = CardContextRead['blocks'][number]
export const isPreparedPacketComment = (comment: Comment) => comment.type === 'comment'
  && /^\s*Prepared packet\s*\(Tinstar Decision Prep\)\s*(?:\r?\n|$)/i.test(comment.text)

const aliases: Record<string, string> = {
  background: 'background', context: 'background', question: 'question', decision: 'decision',
  options: 'options', choices: 'options', recommendation: 'recommendation', recommended: 'recommendation', rationale: 'rationale',
  risk: 'risk', risks: 'risk', reversibility: 'reversibility', rollback: 'rollback', undo: 'reversibility', 'how to undo': 'reversibility', confidence: 'confidence',
  sources: 'sources', evidence: 'sources', references: 'sources',
  'next action after each answer': 'next', 'next actions': 'next', 'next action': 'next', 'after you approve': 'next',
  'cost and effort': 'cost', cost: 'cost', effort: 'cost', uncertainty: 'uncertainty', 'material unknowns': 'unknowns',
}

/** Section labels are flexible; values remain the bot's prose. In particular,
 * this parser never treats prose as a new source option or a source revision. */
function sections(text: string) {
  const values: Record<string, string> = {}
  let current: string | undefined
  for (const line of text.replace(/\r\n?/g, '\n').split('\n').slice(1)) {
    const label = line.match(/^\s*(?:#{1,6}\s*)?(?:\*\*)?([A-Za-z][A-Za-z /&-]*?)(?:\s*\([^)]*\))?(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/)
    const name = label?.[1]?.trim().toLowerCase()
    const key = name && (aliases[name] ?? (/^risk\b/.test(name) ? 'risk' : /^(?:reversibility|undo)\b/.test(name) ? 'reversibility' : /^rollback\b/.test(name) ? 'rollback' : /^confidence\b/.test(name) ? 'confidence' : /^recommend(?:ation|ed)\b/.test(name) ? 'recommendation' : /^options\b/.test(name) ? 'options' : /^sources\b/.test(name) ? 'sources' : undefined))
    if (key && label) { current = key; values[key] = label[2]!.trim(); continue }
    if (current) values[current] = [values[current], line].join('\n').trim()
  }
  return values
}

function recommendation(text: string, optionsText: string | undefined, request: DecisionRequestEvidence) {
  const options = request.binding!.options
  const direct = options.filter(option => text.trim().toLowerCase() === option.id.toLowerCase() || text.trim().toLowerCase() === option.label.toLowerCase())
  if (direct.length === 1) return direct[0]!.id
  // The bot labels the filed options A/B/C. Keep source IDs/labels intact and
  // resolve only an explicit letter (or an exact source ID) in its recommendation.
  const head = text.match(/^(?:option\s+)?([A-Za-z0-9_-]+)(?=[\s.):,;-]|$)/i)?.[1]
  const byId = options.find(option => option.id.toLowerCase() === head?.toLowerCase())
  if (byId) return byId.id
  const letter = head?.match(/^[A-E]$/i)?.[0].toUpperCase()
  if (!letter) return undefined
  if (!optionsText) return options[letter.charCodeAt(0) - 65]?.id
  const filed = [...optionsText.matchAll(/^\s*(?:[-*]\s*)?([A-E])(?:\s*\([^)]*\))?\s*[:.)-]\s*(.+)$/gim)]
  const index = letter.charCodeAt(0) - 65
  // A changed/missing option sequence must not silently remap a recommendation.
  if (!filed[index] || filed.some((entry, i) => entry[1]!.toUpperCase().charCodeAt(0) - 65 !== i)) return undefined
  const freeform = options.filter(option => /free[ -]?form|other|custom/i.test(`${option.id} ${option.label}`))
  if (filed.length !== options.length && !(freeform.length === 1 && filed.length === options.length - 1 && options.at(-1) === freeform[0])) return undefined
  return options[index]?.id
}

export function mapCommentPacket(comment: Comment, evidence: DecisionEvidence): { packet: DecisionPacket; job_id: string | null; comment_id: string; createdAt: number } | null {
  if (!isPreparedPacketComment(comment)) return null
  const fields = sections(comment.text)
  const requestId = fields.decision?.split(/[·\n]/)[0]?.trim()
  const matches = evidence.requests.filter(request => request.binding?.request_id === requestId && !request.answered)
  if (matches.length !== 1) return null
  const request = matches[0]!, binding = request.binding!
  const missing: string[] = []
  const required = (key: string, value: string | undefined) => {
    if (value?.trim()) return value.trim()
    missing.push(`Missing required field: ${key}`)
    return `Not provided in card comment: ${key}`
  }
  const background = required('background', fields.background)
  const rationale = required('rationale', fields.recommendation ?? fields.rationale)
  const risk = required('risk', fields.risk)
  const reversibility = required('reversibility', fields.reversibility ?? fields.rollback)
  const confidence = required('confidence', fields.confidence)
  const recommended = recommendation(fields.recommendation ?? '', fields.options, request)
  if (!recommended) missing.push('Missing required field: recommended_option_id')
  const riskRating = risk.match(/\b(low|medium|moderate|high)\b/i)?.[1]?.toLowerCase()
  if (!riskRating) missing.push('Missing required field: risk.rating')
  const undo = [reversibility, fields.rollback].filter(Boolean).join('\n')
  const reverseRating = /\b(difficult|irreversible|not reversible|non-reversible|hard to (?:reverse|undo)|cannot (?:be )?(?:undo|undone|reverse|reversed|restore|restored)|can[’']t (?:undo|reverse|restore)|no rollback)\b/i.test(undo) ? 'Difficult'
    : /\b(easy|fully reversible|completely reversible|straightforward to undo)\b/i.test(undo) ? 'Easy'
      : /\b(moderate|reversible|can (?:be )?(?:undo(?:ne)?|revert(?:ed)?|reverse(?:d)?|roll(?:ed)? back|change(?:d)? later)|revert|restore|roll back|switch back|back out|revisit(?:ed)? later)\b/i.test(undo) ? 'Moderate' : undefined
  if (!reverseRating) missing.push('Missing required field: reversibility.rating')
  const confidenceRating = confidence.match(/\b(high|medium|low)\b/i)?.[1]?.toLowerCase()
  if (!confidenceRating) missing.push('Missing required field: confidence')
  const sources = required('references', fields.sources)
  const urls = [...new Set(sources.match(/https?:\/\/[^\s)<>]+/g) ?? [])]
  const references = [{ label: 'Source card · prepared packet comment', url: `https://www.notion.so/${binding.card_id.replace(/-/g, '')}#${comment.id.replace(/-/g, '')}` },
    ...urls.map(url => ({ label: 'Packet source', url }))].slice(0, 30)
  // Operational freshness/dependency metadata comes from the same observed
  // request used by publish_prepared_packet, never from the comment's claims.
  const dependencies = request.dependencies.flatMap(dependency => dependency.revision ? [{ kind: dependency.kind, key: dependency.key, revision: dependency.revision }] : [])
  for (const dependency of request.dependencies) if (!dependency.revision) missing.push(`Missing required field: dependencies.${dependency.kind}.${dependency.key}`)
  if (!dependencies.length) return null // No exact binding evidence to store yet.
  const packet = decisionPacketSchema.parse({ schema: 'tinstar.decision-packet.v1', binding,
    title: request.question ?? binding.source_question, question: request.question ?? binding.source_question,
    background: [background, fields.question && `Bot question (advisory):\n${fields.question}`, fields.options && `Options (as prepared):\n${fields.options}`, fields.sources && `Sources:\n${fields.sources}`].filter(Boolean).join('\n\n'),
    rationale: [rationale, fields.rationale].filter(Boolean).join('\n\n'), recommended_option_id: recommended ?? binding.options[0]!.id,
    // The source supplies prose, not separate likelihood/blast-radius/rollback
    // assessments. Preserve that prose in each corresponding detail field.
    risk: { rating: riskRating === 'high' ? 'High' : riskRating === 'low' ? 'Low' : 'Medium', likelihood: risk, explanation: risk, blast_radius: risk },
    reversibility: { rating: reverseRating ?? 'Moderate', explanation: reversibility, rollback: fields.rollback ?? reversibility, residual_exposure: reversibility },
    confidence: confidenceRating === 'high' ? 'High' : confidenceRating === 'low' ? 'Low' : 'Medium',
    uncertainty: [confidence, fields.uncertainty].filter(Boolean), material_unknowns: [...new Set([...missing, ...(fields.unknowns ? [fields.unknowns] : [])])],
    consequences: [fields.next, fields.cost].filter(Boolean), impacted: [], prerequisites: [],
    authorization: { scope: commentPacketAuthorization, next_owner: 'Firstmate', next_status: 'Queued', permitted_follow_up: commentPacketAuthorization, remaining_gates: [] },
    references, dependencies, invalidation_conditions: ['Source request, revision, options or evidence changes.'], review_within_ms: 3600_000,
  })
  return { packet, job_id: fields.decision?.match(/\b(?:prep\s+)?job\s+([a-z0-9-]+)/i)?.[1] ?? null, comment_id: comment.id, createdAt: Date.parse(comment.created_time ?? comment.createdAt ?? '') }
}

/** Notion history normally arrives oldest first. Timestamps take precedence;
 * stable history order is the fallback for connectors without timestamps. */
export function newestCommentPackets(blocks: Comment[], evidence: DecisionEvidence) {
  const latest = new Map<string, { comment: Comment; index: number; mapped: NonNullable<ReturnType<typeof mapCommentPacket>> }>()
  for (const [index, comment] of blocks.entries()) {
    const mapped = mapCommentPacket(comment, evidence)
    if (!mapped) continue
    const previous = latest.get(mapped.packet.binding.request_id)
    const timestamp = (value: Comment) => Date.parse(value.last_edited_time ?? value.created_time ?? value.createdAt ?? '')
    if (!previous || (Number.isFinite(timestamp(comment)) && Number.isFinite(timestamp(previous.comment)) ? timestamp(comment) >= timestamp(previous.comment) : index > previous.index)) latest.set(mapped.packet.binding.request_id, { comment, index, mapped })
  }
  return [...latest.values()].map(({ mapped }) => mapped)
}
