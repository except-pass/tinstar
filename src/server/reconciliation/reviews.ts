import { legacyReviewKey, isReviewStatus, reviewSubmissions, type ReviewView } from '../../shared/reviews'
import type { SourceSnapshot } from './index'
import { ageObservation } from './observation'

/** Status is the sole admission rule. Owner/holds/PRs never create another row. */
export function reviewView(source: SourceSnapshot['intentions'], notes = new Map<string, Array<{ text: string }>>(), now = Date.now()): ReviewView {
  const observation = ageObservation(source, now)
  const complete = observation.status === 'fresh' && observation.coverage === 'complete' && !!observation.data
  const safeUrl = (value: unknown) => {
    try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
  }
  return { complete, observedAt: observation.observedAt,
    warning: complete ? null : 'Review coverage is incomplete or stale; an empty list does not establish that nothing needs review.',
    items: [...new Map((observation.data?.cards ?? []).map(card => [card.id, card])).values()]
      .filter(card => !card.archived && !card.in_trash && isReviewStatus(card.properties.Status?.value))
      .map(card => {
        const submission = reviewSubmissions(notes.get(card.id) ?? []).at(-1) ?? null
        return { id: `review:${card.id}`, cardId: card.id, submissionKey: submission?.submission_key ?? legacyReviewKey(card.id, card.last_edited_time), title: String(card.properties.Name?.value ?? card.id),
          status: String(card.properties.Status?.value), cardUrl: card.url ?? `https://www.notion.so/${card.id}`,
          liveUrl: submission?.live_url ?? safeUrl(card.properties.Link?.value),
          evidenceUrls: submission ? [submission.proof.receipt, ...(submission.proof.kind === 'ui' ? submission.proof.screenshots : [])] : [safeUrl(card.properties.Evidence?.value)].filter((url): url is string => !!url),
          instructions: submission?.instructions ?? (typeof card.properties['Next action']?.value === 'string' ? card.properties['Next action'].value : null),
          submission, evidenceWarning: submission ? null : 'Review submission evidence is unavailable; read the canonical card before accepting.',
        }
      }).sort((a, b) => a.cardId.localeCompare(b.cardId)),
  }
}
