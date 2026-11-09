import { askReplySchema } from '../../shared/ask'

/** Reply content must never poison an installed puller's reconciliation pass.
 * Keep presentation/link/action validation, but degrade content instead of
 * refusing delivery. Correlation and immutable-answer conflicts live in ingest.
 */
export function normalizeAskReply(content: Record<string, unknown>, body: string) {
  const reply = askReplySchema.safeParse(content)
  if (reply.success) return reply.data

  const fields = askReplySchema.shape
  const references = Array.isArray(content.references) ? content.references.flatMap(value => {
    const reference = fields.references.element.safeParse(value)
    return reference.success ? [reference.data] : []
  }).slice(0, 20) : []
  const suggestions = fields.suggested_actions.safeParse(content.suggested_actions)
  return {
    summary: typeof content.summary === 'string' && content.summary.length ? content.summary.slice(0, 2000) : body.slice(0, 240),
    detail: typeof content.detail === 'string' ? content.detail.slice(0, 32000) : body,
    references,
    // Drop an invalid collection as a whole: duplicate IDs and oversized lists
    // must not accidentally promote an ambiguous recommendation into a button.
    suggested_actions: suggestions.success ? suggestions.data : [],
    degraded: true as const,
  }
}
