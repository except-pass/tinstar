// The follow-up model: what the user can ASK about a notice before they answer it.
//
// Runtime-safe (no React, no browser globals) so both bundles import it: the
// server's esbuild bundle validates a submitted `presetId` against this set, and
// the client's vite bundle renders the chips from the same source. That shared
// definition is the point — a preset the widget offers is a preset the API accepts,
// with no second list to drift.
//
// Three ways to ask, in the order a user reaches for them:
//   1. UNIVERSAL presets — the small curated set below, on EVERY notice.
//   2. AGENT-DECLARED follow-ups — a `FollowUp` A2UI component the posting agent
//      puts in the notice content, naming a question it expects for THIS notice.
//      This extends the existing host control model (controls.ts / catalog.tsx);
//      web_core's MessageProcessor/action runtime stays deferred.
//   3. FREEFORM text.
import type { A2uiComponent, A2uiContent } from '../domain/types'

/** The A2UI `component` type string an agent uses to declare a likely follow-up. */
export const FOLLOW_UP_COMPONENT = 'FollowUp'

/** A follow-up question text is capped so a hostile or runaway submit can't bloat
 *  the persisted notice snapshot — the thread is append-only and unbounded in count,
 *  so per-message length is where the bound has to live. */
export const NOTICE_FOLLOWUP_TEXT_MAX = 2000

/** One askable question.
 *  - `label` is the chip the user clicks.
 *  - `question` is what lands on the thread verbatim — kept short so the thread
 *    reads like a conversation, not a spec.
 *  - `guidance` is extra instruction delivered to the AGENT only. It never appears
 *    in the thread, which is how "Simplify your explanation" can carry a precise
 *    definition of what simplifying means without shouting it at the user. */
export interface FollowUpPreset {
  id: string
  label: string
  question: string
  guidance?: string
}

/** The universal set: present on every notice regardless of what the agent declared.
 *  Deliberately SMALL and curated — a wall of chips is a menu, not an affordance.
 *  Each one is a question the user actually asks before they can decide, and each
 *  one is answerable from what the agent already knows without new work.
 *
 *  `simplify` is the load-bearing one and the reason this feature exists: the most
 *  common blocker is not missing information, it's an explanation pitched too high.
 *  Its guidance defines de-nerding precisely, because "simplify" alone reliably
 *  produces a dumbed-down answer that drops the very details the decision needs. */
export const UNIVERSAL_FOLLOW_UPS: readonly FollowUpPreset[] = [
  {
    id: 'simplify',
    label: 'Simplify your explanation',
    question: 'Can you explain that more plainly?',
    guidance:
      'Rewrite this notice\'s background in plainer language. Unpack the jargon, break long ' +
      'compound sentences into one idea each, and define any project-internal or acronym-heavy ' +
      'term the first time it appears. KEEP the precision: every load-bearing detail, caveat, ' +
      'and edge case stays. Do NOT dumb it down, do not drop distinctions, and do not hedge — ' +
      'the target reader is a smart peer outside this specific niche, not a beginner. ' +
      'Amend the notice with the plainer version; do not merely append a glossary.',
  },
  {
    id: 'why',
    label: 'Why this?',
    question: 'Why does this need deciding, and why now?',
    guidance: 'Explain what forced this to the board — what you hit, and what you cannot do until it is settled.',
  },
  {
    id: 'do-nothing',
    label: 'What if I do nothing?',
    question: 'What happens if I do nothing?',
    guidance:
      'State the default outcome if the user never answers: what you will do, what breaks or ' +
      'degrades, and how reversible that is. Be concrete about the cost of waiting.',
  },
  {
    id: 'background',
    label: 'More background',
    question: 'Can you give me more background?',
    guidance: 'Add the context you left out for brevity — prior attempts, constraints, and what you already ruled out.',
  },
  {
    id: 'show-code',
    label: 'Show me the code',
    question: 'Show me the code or diff behind this.',
    guidance:
      'Point at the actual code: file paths with line numbers, and the relevant diff or snippet ' +
      'in a Code component. Show, do not describe.',
  },
]

const UNIVERSAL_BY_ID: ReadonlyMap<string, FollowUpPreset> =
  new Map(UNIVERSAL_FOLLOW_UPS.map(p => [p.id, p]))

/** Parse a `FollowUp` node's agent-authored props into a validated preset, or `null`
 *  when it is malformed, so the renderer degrades it instead of throwing (KTD4/R16).
 *
 *  Everything here is agent-authored and the A2UI schema is `.passthrough()`, so this
 *  is a real input boundary: `id`, `label`, and `question` must each be a non-empty
 *  string, and the question is length-capped. There is deliberately NO url/href field
 *  on a FollowUp — a follow-up asks the agent, it never navigates, so this component
 *  can't become the `javascript:` href vector that `Link` had to defend against. */
export function parseFollowUp(node: A2uiComponent): FollowUpPreset | null {
  // Guard the node itself, not just its props: content is schema-validated at the
  // API boundary, but a snapshot persisted by an older build could still carry a
  // null or non-object entry, and a throw here would take out the whole board
  // (the ask panel sits OUTSIDE the renderer's per-notice error boundary).
  if (node === null || typeof node !== 'object') return null
  if (node.component !== FOLLOW_UP_COMPONENT) return null
  const { id, label, question } = node as { id?: unknown; label?: unknown; question?: unknown }
  if (typeof id !== 'string' || id === '') return null
  if (typeof label !== 'string' || label === '') return null
  if (typeof question !== 'string' || question === '' || question.length > NOTICE_FOLLOWUP_TEXT_MAX) return null
  // A declared id must not shadow a universal preset — otherwise an agent could
  // redefine what "simplify" means for its own notice and the guidance the user
  // relies on would silently change per card.
  if (UNIVERSAL_BY_ID.has(id)) return null
  return { id, label, question }
}

/** Every follow-up an agent declared on this notice, in declaration order, with
 *  duplicate ids collapsed (first wins). Scans the flat component list — a safe
 *  superset of what the walker renders, so a declaration that is unreachable in the
 *  tree still surfaces in the ask panel. */
export function collectDeclaredFollowUps(content: A2uiContent | undefined | null): FollowUpPreset[] {
  const out: FollowUpPreset[] = []
  const seen = new Set<string>()
  if (!content || !Array.isArray(content.components)) return out
  for (const node of content.components) {
    const parsed = parseFollowUp(node)
    if (parsed && !seen.has(parsed.id)) { seen.add(parsed.id); out.push(parsed) }
  }
  return out
}

/** The full ask menu for a notice: the universal set first (stable, learnable
 *  position), then whatever the agent declared. */
export function followUpsFor(content: A2uiContent | undefined | null): FollowUpPreset[] {
  return [...UNIVERSAL_FOLLOW_UPS, ...collectDeclaredFollowUps(content)]
}

/** Resolve a submitted `presetId` against the notice's own menu — the single source
 *  of truth the API validates against (an id outside this set is rejected and nothing
 *  is persisted, mirroring how `choices[]` is checked against the declared options). */
export function resolveFollowUp(
  content: A2uiContent | undefined | null,
  presetId: string,
): FollowUpPreset | null {
  return followUpsFor(content).find(p => p.id === presetId) ?? null
}
