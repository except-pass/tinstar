/**
 * Decide the text of the Saloon header's "subscribed:" line.
 *
 * The run-bound case has three distinct states that previously all collapsed
 * to "resolving…":
 *   - not yet resolved (no session payload back from the capability) → transient
 *   - resolved, but the session has no subjects (NATS not enabled for it) → terminal
 *   - resolved with subjects → show them
 *
 * Conflating the middle case with the first made a perfectly-resolved-but-empty
 * binding look like it was stuck loading forever. `resolved` is the signal that
 * at least one bound session's `session.nats` payload has come back.
 */
export function subscribedLabel(input: {
  mode: 'all' | 'runs' | 'empty'
  subjects: string[]
  resolved: boolean
}): string {
  if (input.mode === 'all') return 'tinstar.> (all sessions)'
  if (input.subjects.length) return input.subjects.join('  ·  ')
  return input.resolved ? 'no subjects — NATS not enabled' : 'resolving…'
}
