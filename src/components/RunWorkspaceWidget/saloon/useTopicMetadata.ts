import { useBackendState } from '../../../hooks/useBackendState'
import type { TopicMetadata } from '../../../domain/types'

export function useTopicMetadata(subject: string): TopicMetadata | undefined {
  const { topicMetadata } = useBackendState()
  return topicMetadata.find(m => m.subject === subject)
}
