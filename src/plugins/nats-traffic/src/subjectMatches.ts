// NATS subject matching: '*' matches exactly one token, '>' matches one or
// more trailing tokens, literal tokens compare exactly.
export function subjectMatches(subject: string, pattern: string): boolean {
  const s = subject.split('.')
  const p = pattern.split('.')
  for (let i = 0; i < p.length; i++) {
    const tok = p[i]
    if (tok === '>') return s.length > i // ≥1 token remaining
    if (i >= s.length) return false
    if (tok === '*') continue
    if (tok !== s[i]) return false
  }
  return s.length === p.length
}

/** True if `subject` matches any of the patterns. */
export function subjectMatchesAny(subject: string, patterns: string[]): boolean {
  return patterns.some(p => subjectMatches(subject, p))
}
