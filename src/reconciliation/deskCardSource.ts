import { cardSourceUrl, isJiraCard } from '../shared/workIdentity'
import type { QueueItem } from '../server/reconciliation/queue'

export function deskCardSource(id: string, item?: QueueItem, card?: { url: string | null; source?: { provider: 'jira' } }) {
  const source = item?.sources.find(source => source.id === id && source.request?.home === null)
  const jira = source?.kind === 'jira' || card?.source?.provider === 'jira' || id.startsWith('jira:')
  return { url: source?.url ?? card?.url ?? (!jira || isJiraCard(id) ? cardSourceUrl(id) : undefined), provider: jira ? 'Jira' : 'Notion' }
}
