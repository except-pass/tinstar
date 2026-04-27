import type { TopicMetadata } from '../domain/types'
import type { Session } from './sessions/session'

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
