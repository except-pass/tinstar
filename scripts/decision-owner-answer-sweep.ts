import { parseArgs } from 'node:util'
import { projectDecisionHistory } from '../src/shared/workflowRequests'
import { AskStore } from '../src/server/ask/store'
import { ProposalSource } from '../src/server/reconciliation/proposalSource'
import { getConfigRoot } from '../src/server/configRoot'
import { CardContextReader } from '../src/server/reconciliation/cardContext'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { NotionApi } from '../src/server/reconciliation/notionApi'
import { WorkReader } from '../src/server/reconciliation/workReader'

async function main() {
  const { values } = parseArgs({ options: { 'config-home': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('Usage: npx tsx scripts/decision-owner-answer-sweep.ts [--config-home DIR]\nLists Notion requests whose owner decision closes an ask previously left open. Read-only.')
    return
  }
  const root = values['config-home'] ?? getConfigRoot()
  const config = loadReconciliationConfig(root)
  if (!config.notion) throw new Error('Notion is not configured')
  const api = new NotionApi()
  const board = await new WorkReader(config.notion, api).query({ history: true }, true)
  const history = new CardContextReader(config.notion, api.backgroundFetch)
  const asks = new AskStore(root)
  await asks.loadProposals()
  const proposals = new ProposalSource(asks, async id => (await history.decisionDetails(id)).blocks)
  const cards = (board.data?.cards ?? []).filter(card => !card.archived && !card.in_trash)
  const matches: { card_id: string; request_id: string; request_note_id: string; answer_comment_id: string }[] = []
  const incomplete: string[] = []
  for (const card of cards) {
    const context = await history.decisionDetails(card.id)
    if (context.outcome !== 'available' || context.commentsOutcome !== 'available') {
      incomplete.push(card.id)
      continue
    }
    const projection = projectDecisionHistory(context.blocks, proposals.cachedPublications(card.id, context.blocks))
    if (projection.verification || projection.unmatchedOwnerDecision || [...projection.requests.values()].some(state => state.verification)) {
      incomplete.push(card.id)
      continue
    }
    for (const [request_id, state] of projection.requests) {
      if (!state.ownerAnswer || state.answers.some(note => note !== state.ownerAnswer?.note)) continue
      matches.push({ card_id: card.id, request_id, request_note_id: state.publication.id, answer_comment_id: state.ownerAnswer.note.id })
    }
  }
  const complete = board.status === 'fresh' && board.coverage === 'complete' && !board.data?.hasMore && !incomplete.length
  console.log(JSON.stringify({ complete, cards_scanned: cards.length, count: matches.length, matches, incomplete_cards: incomplete }, null, 2))
  if (!complete) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Owner answer sweep failed'); process.exitCode = 1 })
