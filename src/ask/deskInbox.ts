import { displayRequestText } from '../shared/requestText'
import type { AskItem } from '../shared/ask'

// A saved note can be delivered while waking First Mate explicitly failed.
export function deliveryFailed(item: AskItem) {
  return !item.reply && (item.status === 'failed' || !!item.error)
}

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
    const failed = turns.some(turn => !turn.dismissed_at && deliveryFailed(turn))
    const view: DeskView = archived ? 'history' : unread || failed || latest.reply?.suggested_actions.some(action => typeof action !== 'string') ? 'needs-you' : latest.reply ? 'history' : 'waiting'
    const updatedAt = turns.reduce((latest, turn) => turn.updated_at > latest ? turn.updated_at : latest, '')
    return { id, turns, latest, unread, failed, view, updatedAt }
  }).sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export function answerStatus(item: AskItem) {
  return item.reply ? item.read_at ? 'Answered' : 'New answer' : deliveryFailed(item) ? 'Delivery failed' : 'Waiting for answer'
}

/** Prefer the newest human question over a selection instruction. Action-only
 * legacy conversations use First Mate's retained summary or action label. */
export function conversationTitle(turns: AskItem[]) {
  const latest = turns.at(-1)!
  const question = [...turns].reverse().find(turn => !turn.action_selection)
  const title = question?.question ?? latest.reply?.summary ?? latest.action_selection?.label ?? latest.question
  return displayRequestText(title, 'Conversation with First Mate')
}
