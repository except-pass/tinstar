import { parseArgs } from 'node:util'
import { decisionRequests } from '../src/shared/workflowRequests'
import { decisionProposals } from '../src/server/reconciliation/decisionResolution'
import { getConfigRoot } from '../src/server/configRoot'
import { CardContextReader } from '../src/server/reconciliation/cardContext'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { NotionApi } from '../src/server/reconciliation/notionApi'
import { WorkReader } from '../src/server/reconciliation/workReader'

async function main() {
  const { values } = parseArgs({ options: { 'config-home': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('Usage: npx tsx scripts/decision-owner-answer-sweep.ts [--config-home DIR]\nLists open Notion requests followed by an OWNER DECISION comment. Read-only.')
    return
  }
  const root = values['config-home'] ?? getConfigRoot()
  const config = loadReconciliationConfig(root)
  if (!config.notion) throw new Error('Notion is not configured')
  const api = new NotionApi()
  const board = await new WorkReader(config.notion, api).query({ history: true }, true)
  const history = new CardContextReader(config.notion, api.backgroundFetch)
  const cards = (board.data?.cards ?? []).filter(card => !card.archived && !card.in_trash)
  const matches: { card_id: string; request_id: string; request_note_id: string; owner_comment_id: string }[] = []
  const incomplete: string[] = []
  for (const card of cards) {
    const context = await history.decisionDetails(card.id)
    if (context.outcome !== 'available' || context.commentsOutcome !== 'available') {
      incomplete.push(card.id)
      continue
    }
    const ownerComments = context.blocks.filter(block => block.type === 'comment' &&
      /^OWNER DECISION\b/.test(block.text.trimStart()))
    if (!ownerComments.length) continue
    let current: Set<string>
    try { current = new Set(decisionProposals(context.blocks.map(({ id, text }) => ({ id, text }))).map(row => row.id)) }
    catch { incomplete.push(card.id); continue }
    const open = decisionRequests(context.blocks).filter(request => !request.answered && current.has(request.id))
    if (open.length && (open.some(request => !Number.isFinite(Date.parse(request.since ?? ''))) ||
      ownerComments.some(comment => !Number.isFinite(Date.parse(comment.createdAt ?? ''))))) incomplete.push(card.id)
    for (const request of open) for (const comment of ownerComments) {
      if (!(Date.parse(comment.createdAt ?? '') > Date.parse(request.since ?? ''))) continue
      matches.push({ card_id: card.id, request_id: request.id, request_note_id: request.sourceId, owner_comment_id: comment.id })
    }
  }
  const complete = board.status === 'fresh' && board.coverage === 'complete' && !board.data?.hasMore && !incomplete.length
  console.log(JSON.stringify({ complete, cards_scanned: cards.length, count: new Set(matches.map(match => JSON.stringify([match.card_id, match.request_id]))).size, matches, incomplete_cards: incomplete }, null, 2))
  if (!complete) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Owner answer sweep failed'); process.exitCode = 1 })
