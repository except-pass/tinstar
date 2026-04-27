import type { TopicMetadata } from '../domain/types'
import type { Session } from './sessions/session'
import type { DocumentStore } from './stores/document-store'
import { sanitizeSubjectToken } from './sessions/nats-subscriptions'

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
  if (!subject.startsWith('tinstar.')) return null
  const parts = subject.split('.')
  if (kind === 'dm') {
    // DM: tinstar.<space>.<init>.<epic>.<task>.<session> = 6 parts
    if (parts.length !== 6) return null
    const session = parts[parts.length - 1]
    return session ? `DM → ${session}` : null
  }
  // broadcast: tinstar.<space>.<init>.<epic>.<task> = 5 parts
  if (parts.length !== 5) return null
  const taskToken = parts[parts.length - 1]
  if (!taskToken) return null
  const tasks = docStore.getAllTasks().filter(t => sanitizeSubjectToken(t.name) === taskToken)
  const task = tasks[0]
  if (!task) return `Task: ${taskToken}` // fallback if no entity match
  return `Task: ${task.name}`
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
