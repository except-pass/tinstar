import type { TopicMetadata } from '../domain/types'
import type { Session } from './sessions/session'
import type { DocumentStore } from './stores/document-store'
import { sanitizeSubjectToken } from './sessions/nats-subscriptions'
import { parseSubject } from './nats/subjects'

export function topicParticipants(subject: string, sessions: Session[]): string[] {
  return sessions
    .filter(s => s.nats?.subscriptions?.includes(subject))
    .map(s => s.name)
    .sort()
}

export interface TopicMetadataWithParticipants extends TopicMetadata {
  participants: string[]
}

export function joinParticipants(
  md: TopicMetadata,
  sessions: Session[],
): TopicMetadataWithParticipants {
  return { ...md, participants: topicParticipants(md.subject, sessions) }
}

export function deriveHierarchicalName(
  subject: string,
  docStore: DocumentStore,
  kind: 'broadcast' | 'dm',
): string | null {
  const parsed = parseSubject(subject)
  if (!parsed || parsed.kind === 'breakout') return null
  if (kind === 'dm') {
    if (parsed.kind !== 'dm') return null
    return parsed.session ? `DM → ${parsed.session}` : null
  }
  if (parsed.kind !== 'broadcast') return null
  if (parsed.project.includes('*') || parsed.project.includes('>')
    || parsed.worktree.includes('*') || parsed.worktree.includes('>')) return null
  const worktree = docStore.getAllWorktrees().find(candidate =>
    sanitizeSubjectToken(candidate.repo) === parsed.project
    && sanitizeSubjectToken(candidate.branch || candidate.name) === parsed.worktree,
  )
  return `Worktree: ${worktree?.branch || worktree?.name || parsed.worktree}`
}

export function bootstrapHierarchicalTopicMetadata(
  subjects: string[],
  sessionName: string,
  docStore: DocumentStore,
): void {
  if (subjects.length === 0) return
  const [broadcast, dm] = subjects
  const now = new Date().toISOString()
  if (broadcast && !docStore.getTopicMetadata(broadcast)) {
    docStore.upsertTopicMetadata(broadcast, {
      subject: broadcast,
      name: deriveHierarchicalName(broadcast, docStore, 'broadcast') ?? undefined,
      kind: 'broadcast',
      createdAt: now,
      createdBy: sessionName,
    })
  }
  if (dm && dm !== broadcast && !docStore.getTopicMetadata(dm)) {
    docStore.upsertTopicMetadata(dm, {
      subject: dm,
      name: deriveHierarchicalName(dm, docStore, 'dm') ?? undefined,
      kind: 'dm',
      createdAt: now,
      createdBy: sessionName,
    })
  }
}
