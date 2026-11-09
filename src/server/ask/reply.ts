import { askReplySchema } from '../../shared/ask'
import { askActionSchema, askSuggestionSchema } from '../../shared/ask-actions'

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
  const suggestions = fields.suggested_actions.safeParse(content.suggested_actions)
  const rejectedActions = suggestions.success ? [] : Array.isArray(content.suggested_actions)
    ? content.suggested_actions.map((value: unknown, index: number) => {
      const action = typeof value === 'string' ? askSuggestionSchema.safeParse(value) : askActionSchema.safeParse(value)
      const issues = action.success ? suggestions.error.issues.filter(issue => !issue.path.length || issue.path[0] === index) : action.error.issues
      const reason = issues.length ? issues.map(issue => `${issue.path.join('.') || 'suggested_actions'}: ${issue.message}`).join('; ')
        : 'Suggested action collection rejected because another entry is invalid'
      return { index, ...(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? { id: value.id } : {}), reason }
    })
    : [{ reason: 'suggested_actions must be an array of at most 10 suggestions' }]
  return {
    summary: typeof content.summary === 'string' && content.summary.length ? content.summary.slice(0, 2000) : body.slice(0, 240),
    detail: typeof content.detail === 'string' ? content.detail.slice(0, 32000) : body,
    references,
    // Drop an invalid collection as a whole: duplicate IDs and oversized lists
    // must not accidentally promote an ambiguous recommendation into a button.
    suggested_actions: suggestions.success ? suggestions.data : [],
    ...(rejectedActions.length ? { rejected_actions: rejectedActions } : {}),
    degraded: true as const,
  }
}
