// Central NATS subject builder + parser. Replaces the inlined templates and
// magic part-count parsers that drifted across routes.ts, topic-metadata.ts,
// and nats-subscriptions.ts. Authoritative shape per docs/nats-agent-channels.md:
//
//   broadcast:  tinstar.<space>.<init>.<epic>.<task>           (5 parts)
//   dm:         tinstar.<space>.<init>.<epic>.<task>.<session> (6 parts)
//   breakout:   tinstar.room.<room-name>

export const TINSTAR_PREFIX = 'tinstar.'
export const BREAKOUT_PREFIX = 'tinstar.room.'

export interface AgentSubjectParts {
  space: string
  init: string
  epic: string
  task: string
  session?: string
}

export function buildAgentSubject(parts: AgentSubjectParts): string {
  const base = `${TINSTAR_PREFIX}${parts.space}.${parts.init}.${parts.epic}.${parts.task}`
  return parts.session ? `${base}.${parts.session}` : base
}

export type ParsedSubject =
  | { kind: 'breakout'; room: string }
  | { kind: 'broadcast'; space: string; init: string; epic: string; task: string }
  | { kind: 'dm'; space: string; init: string; epic: string; task: string; session: string }

export function parseSubject(subject: string): ParsedSubject | null {
  if (subject.startsWith(BREAKOUT_PREFIX)) {
    const room = subject.slice(BREAKOUT_PREFIX.length)
    if (!room) return null
    return { kind: 'breakout', room }
  }
  if (!subject.startsWith(TINSTAR_PREFIX)) return null

  const parts = subject.split('.')
  if (parts.length === 5) {
    return { kind: 'broadcast', space: parts[1]!, init: parts[2]!, epic: parts[3]!, task: parts[4]! }
  }
  if (parts.length === 6) {
    return { kind: 'dm', space: parts[1]!, init: parts[2]!, epic: parts[3]!, task: parts[4]!, session: parts[5]! }
  }
  return null
}
