import { cardSourceUrl, isJiraCard } from '../shared/workIdentity'
import type { QueueItem } from '../server/reconciliation/queue'

export function deskCardSource(id: string, item?: QueueItem, card?: { url: string | null }) {
  if (isJiraCard(id)) return { url: cardSourceUrl(id), provider: 'Jira' }
  if (!id.startsWith('jira:')) return { url: cardSourceUrl(id), provider: 'Notion' }
  const source = item?.sources.find(source => source.id === id && source.request?.home === null)
  return { url: source?.url ?? card?.url ?? undefined, provider: 'Jira' }
}
