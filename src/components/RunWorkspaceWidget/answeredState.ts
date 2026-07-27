// The DURABLE "the user already answered this" signal, shared by every Slate surface
// that can be answered (the open-points ROW and the workbench COLUMN). It lives here,
// in one exported place, because the two render paths must agree: a point answered in
// a column and then re-read as a row — or vice versa after a re-projection — has to
// look answered in both.
//
// MONOTONIC BY CONSTRUCTION. The predicate this replaced read
// `status === 'waiting' || status === 'resolved'`, and `status` is derived server-side
// from WHO SPOKE LAST (`derivePointStatus`: last reply by the user → `waiting`, last
// reply by the agent → `discussing`). So the answered marker was erased the moment the
// agent replied to act on the answer — it survived right up until the thing it marks
// actually happened, which is the worst possible moment to forget it.
//
// "Did the user speak last" is the wrong question. "Does this thread contain a user
// answer" is the right one, and nothing an agent does afterwards can un-ask it.
import type { SlateSurface } from '../../types'

/**
 * True when this surface's thread already carries the user's answer.
 *
 * Two ways to be answered, both one-way doors:
 *   · `resolved` — the explicit terminal (set only by an explicit resolve, and it
 *     survives a file re-projection), so it stays true even if the thread was pruned.
 *   · the thread holds at least one USER-authored reply — which is exactly what
 *     submitting an answer leaves behind (the answer route appends a user reply).
 *     An `agent`/`process` reply landing afterwards appends, it never removes, so
 *     this can only ever go from false to true.
 *
 * NOT included: `status === 'waiting'`. It is the same fact read off the last author
 * only, and reading it that way is precisely the bug — a later agent reply flips it
 * to `discussing`. Any point that is genuinely `waiting` has a user reply in its
 * thread (the projection ships `thread` whenever the point has replies), so this is
 * strictly the same set minus the volatility.
 */
export function durablyAnswered(s: SlateSurface): boolean {
  if (s.status === 'resolved') return true
  return (s.thread ?? []).some((reply) => reply.author === 'user')
}
