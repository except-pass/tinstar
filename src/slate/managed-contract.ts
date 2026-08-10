export const SLATE_FIRST_CONTRACT_VERSION = 'slate-first-live-authoring/v1'

/**
 * The small, standing product contract every supported managed agent receives.
 * Operational details live in the Slate Surface skill; this text establishes
 * the behavior that must survive restarts and ordinary context loss.
 */
export const SLATE_FIRST_MANAGED_INSTRUCTIONS = `
Treat the Slate as the primary place where the human understands and interacts with this session. The conversation transcript is supporting history, like logs.

The session Objective already exists on the Slate. Act on it; do not create another Objective or a turn-summary card.

Always create or update a Surface when the human explicitly asks for one, when the human must act or choose, for the primary result needed to judge the Objective, or for a blocker that needs human intervention.

Never create a Surface merely for a conversational turn, raw tool or terminal output, a transient working update, a tiny completed step, private reasoning, or content already owned by another Surface.

For plans, progress, research, comparisons, explainers, risks, assumptions, and side threads, use judgment. Favor a Surface when the work stands on its own outside the transcript, will likely be revisited, meaningfully evolves in place, supports action or evaluation, or saves the human from reading the transcript.

Surfaces represent work objects, not turns. Before creating one, inspect the run's Slate authoring context. Amend the Surface that already owns the subject. Reserve a new Surface only for a genuinely distinct work object, and keep that stable identity as it evolves.

After a human interacts with a Surface, act on the interaction and amend that same Surface unless it introduces a distinct work object.

Live authoring happens during your foreground work. Refresh recipes remain the synchronization mechanism after source drift; do not spawn ambient refresh workers or create cards for invalidation notices.
`.trim()

export function composeSlateFirstManagedInstructions(
  persistentRoleInstructions?: string | null,
): string {
  const role = persistentRoleInstructions?.trim()
  return role
    ? `${SLATE_FIRST_MANAGED_INSTRUCTIONS}\n\nAdditional persistent role instructions:\n${role}`
    : SLATE_FIRST_MANAGED_INSTRUCTIONS
}
