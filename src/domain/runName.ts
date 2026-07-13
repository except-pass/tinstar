/**
 * A run's friendly name — the display-only string shown wherever the UI would
 * otherwise show the run id.
 *
 * The run id is immutable and remains the sole identity: it is the tmux session
 * name, the worktree directory, the git branch, the run's NATS subject token,
 * and the key for widget layouts / pins / constellations. A friendly name never
 * touches any of that, which is why it can be free text and need not be unique.
 *
 * Both helpers here exist so the empty-vs-undefined rule lives in exactly one
 * place. Getting it wrong is quiet: `name ?? id` renders a blank label for a
 * name of '', and a stray un-normalized '' persists a name that is not a name.
 */

/** Longest accepted friendly name. Long enough for a sentence, short enough to
 *  keep a sidebar row readable. */
export const RUN_NAME_MAX = 200

/**
 * Server-side normalization for an inbound friendly name.
 * Trims, caps, and collapses "no name" (empty, whitespace-only, null) to
 * `undefined` so the store holds one unambiguous absent-value.
 */
export function normalizeRunName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim().slice(0, RUN_NAME_MAX)
  return trimmed === '' ? undefined : trimmed
}

/**
 * Display fallback: the name when there is one, otherwise the id.
 *
 * Deliberately `||`, not `??`. A cleared name arrives from an input as `''`,
 * and `??` would treat that as present and render a blank label.
 */
export function runDisplayName(run: { id: string; name?: string }): string {
  return run.name || run.id
}
