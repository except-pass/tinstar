// Canonical collaboration subjects:
//   broadcast: tinstar.<space>.<project>.<worktree>
//   dm:        tinstar.<space>.<project>.<worktree>.<session>
//   breakout:  tinstar.room.<room-name>

export const TINSTAR_PREFIX = 'tinstar.'
export const BREAKOUT_PREFIX = 'tinstar.room.'

export interface AgentSubjectParts {
  space: string
  project: string
  worktree: string
  session?: string
}

export function buildAgentSubject(parts: AgentSubjectParts): string {
  const base = `${TINSTAR_PREFIX}${parts.space}.${parts.project}.${parts.worktree}`
  return parts.session ? `${base}.${parts.session}` : base
}

export type ParsedSubject =
  | { kind: 'breakout'; room: string }
  | { kind: 'broadcast'; space: string; project: string; worktree: string }
  | { kind: 'dm'; space: string; project: string; worktree: string; session: string }

export function parseSubject(subject: string): ParsedSubject | null {
  if (subject.startsWith(BREAKOUT_PREFIX)) {
    const room = subject.slice(BREAKOUT_PREFIX.length)
    return room ? { kind: 'breakout', room } : null
  }
  if (!subject.startsWith(TINSTAR_PREFIX)) return null
  const parts = subject.split('.')
  if (parts.length === 4) {
    return { kind: 'broadcast', space: parts[1]!, project: parts[2]!, worktree: parts[3]! }
  }
  if (parts.length === 5) {
    return { kind: 'dm', space: parts[1]!, project: parts[2]!, worktree: parts[3]!, session: parts[4]! }
  }
  return null
}
