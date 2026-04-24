/**
 * NATS-style subject matcher.
 *
 * - `*` in a pattern segment matches any single event segment
 * - `>` as the final pattern segment matches one-or-more remaining event segments
 *   (NATS semantics: at least one remaining token required)
 * - All other segments must match exactly
 */
export function subjectMatches(event: string, pattern: string): boolean {
  const eSegs = event.split('.')
  const pSegs = pattern.split('.')
  const lastP = pSegs.length - 1
  if (pSegs[lastP] === '>') {
    if (eSegs.length <= lastP) return false
    for (let i = 0; i < lastP; i++) {
      if (pSegs[i] !== '*' && pSegs[i] !== eSegs[i]) return false
    }
    return true
  }
  if (eSegs.length !== pSegs.length) return false
  for (let i = 0; i < pSegs.length; i++) {
    if (pSegs[i] !== '*' && pSegs[i] !== eSegs[i]) return false
  }
  return true
}
