import type { AskItem } from '../shared/ask'

export type DeskView = 'needs-you' | 'waiting' | 'history'

/** Count conversations, not transport requests or individual follow-up turns. */
export function deskConversations(items: AskItem[]) {
  const conversations = new Map<string, AskItem[]>()
  for (const item of items) {
    const turns = conversations.get(item.conversation_id) ?? []
    turns.push(item)
    conversations.set(item.conversation_id, turns)
  }
  return [...conversations.entries()].map(([id, turns]) => {
    turns.sort((a, b) => a.created_at.localeCompare(b.created_at))
    const latest = turns.at(-1)!
    const archived = turns.every(turn => !!turn.dismissed_at)
    const unread = !archived && turns.some(turn => !turn.dismissed_at && turn.reply && !turn.read_at)
    const failed = turns.some(turn => !turn.dismissed_at && !turn.reply && turn.status === 'failed')
    const view: DeskView = archived ? 'history' : unread || failed || latest.reply ? 'needs-you' : 'waiting'
    const updatedAt = turns.reduce((latest, turn) => turn.updated_at > latest ? turn.updated_at : latest, '')
    return { id, turns, latest, unread, failed, view, updatedAt }
  }).sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export function answerStatus(item: AskItem) {
  return item.reply ? item.read_at ? 'Answered' : 'New answer' : item.status === 'failed' ? 'Delivery failed' : 'Waiting for answer'
}
