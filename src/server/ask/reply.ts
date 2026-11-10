import { askReplySchema } from '../../shared/ask'
import { askActionSchema, askSuggestionSchema, askSuggestionsSchema, type AskSuggestion } from '../../shared/ask-actions'

type RejectedAction = { index?: number; id?: string; reason: string }

function rejectionId(value: unknown) {
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? { id: value.id } : {}
}
function issueReason(issues: { path: PropertyKey[]; message: string }[]) {
  return issues.map(issue => `${issue.path.join('.') || 'suggested_actions'}: ${issue.message}`).join('; ')
}

/** Reply content must never poison an installed puller's reconciliation pass.
 * Keep presentation/link/action validation, but degrade content instead of
 * refusing delivery. Correlation and immutable-answer conflicts live in ingest.
 */
export function normalizeAskReply(content: Record<string, unknown>, body: string) {
  // Rejection diagnostics are generated here, not supplied by the reply author.
  const reply = askReplySchema.omit({ rejected_actions: true }).safeParse(content)
  if (reply.success) return reply.data

  const fields = askReplySchema.shape
  const references = Array.isArray(content.references) ? content.references.flatMap(value => {
    const reference = fields.references.element.safeParse(value)
    return reference.success ? [reference.data] : []
  }).slice(0, 20) : []
  const { suggested_actions, rejectedActions } = normalizeSuggestions(content.suggested_actions)
  return {
    summary: typeof content.summary === 'string' && content.summary.length ? content.summary.slice(0, 2000) : body.slice(0, 240),
    detail: typeof content.detail === 'string' ? content.detail.slice(0, 32000) : body,
    references,
    suggested_actions,
    ...(rejectedActions.length ? { rejected_actions: rejectedActions } : {}),
    degraded: true as const,
  }
}

function normalizeSuggestions(raw: unknown): { suggested_actions: AskSuggestion[]; rejectedActions: RejectedAction[] } {
  if (!Array.isArray(raw)) return { suggested_actions: [], rejectedActions: [{ reason: 'suggested_actions must be an array of at most 10 suggestions' }] }
  const parsed = raw.map((value, index) => ({
    value, index,
    action: typeof value === 'string' ? askSuggestionSchema.safeParse(value) : askActionSchema.safeParse(value),
  }))
  const kept = parsed.flatMap(item => item.action.success ? [item.action.data] : [])
  // A single bad entry (a URL in the instruction, a missing id) is omitted on
  // its own. Duplicate IDs and lists over 10 still drop the whole set: keeping
  // a partial list would promote an ambiguous recommendation into a button.
  const collection = askSuggestionsSchema.safeParse(kept)
  if (collection.success) {
    return {
      suggested_actions: collection.data,
      rejectedActions: parsed.flatMap(item => item.action.success ? [] : [{
        index: item.index, ...rejectionId(item.value), reason: issueReason(item.action.error.issues),
      }]),
    }
  }
  const suggestions = askSuggestionsSchema.safeParse(raw)
  return {
    suggested_actions: [],
    rejectedActions: parsed.map(item => {
      const issues = item.action.success
        ? suggestions.success ? [] : suggestions.error.issues.filter(issue => !issue.path.length || issue.path[0] === item.index)
        : item.action.error.issues
      const reason = issues.length ? issueReason(issues) : 'Suggested action collection rejected because another entry is invalid'
      return { index: item.index, ...rejectionId(item.value), reason }
    }),
  }
}
