export type SubjectRole = 'broadcast' | 'dm' | 'breakout'

const BREAKOUT_PREFIX = 'tinstar.breakout.'

export function classifySubject(subject: string, sessionName: string): SubjectRole {
  const s = subject.toLowerCase()
  const name = sessionName.toLowerCase()
  if (s.startsWith(BREAKOUT_PREFIX)) return 'breakout'
  if (s.endsWith(`.${name}`)) return 'dm'
  return 'broadcast'
}
