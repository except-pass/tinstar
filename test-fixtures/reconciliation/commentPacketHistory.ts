/** Real comment format against a disposable, card-native request and stub Notion
 * transport. No production credentials, source writes, or webhook are used. */
import { readFileSync } from 'node:fs'
import { DecisionPreparation } from '../../src/server/reconciliation/decisionPrep'
import { preparationHistoryFixture } from './preparationHistory'

export const sampleCommentPacket = readFileSync(new URL('./prepared-comment-packet.txt', import.meta.url), 'utf8')
export const sampleCommentQuestion = sampleCommentPacket.match(/^Question: (.+)$/m)![1]!
export const sampleCommentRequest = 'influx-lifecycle-decision'
export const sampleCommentOptions = [
  { id: 'staged-plan', label: 'Build the staged lifecycle plan; nothing deleted without separate approval' },
  { id: 'defer', label: 'Defer lifecycle work' },
  { id: 'buy-disk', label: 'Keep full detail and buy disk as needed' },
  { id: 'freeform', label: 'Free-form answer' },
]

export async function commentPacketHistoryFixture(root: string, options: { answered?: boolean; packet?: string; cards?: number; prepare?: boolean; jobIds?: Map<string, string> } = {}) {
  let comments = [{ id: 'sample-packet-comment', text: options.packet ?? sampleCommentPacket, created_time: '2026-11-16T23:40:00Z' }]
  const jobIds = options.jobIds ?? new Map<string, string>()
  let revision = 0
  const fixture = await preparationHistoryFixture(root, async () => null, { cards: options.cards,
    wrapFetch: fixtureFetch => async (input, init) => {
      const url = new URL(String(input))
      const response = await fixtureFetch(input, init)
      if (url.pathname !== '/v1/comments' || (init?.method ?? 'GET') !== 'GET') return response
      const job = jobIds.get(url.searchParams.get('block_id') ?? '')
      const request = { id: sampleCommentRequest, action: 'Decision', preserve_action: false, options: sampleCommentOptions }
      const texts = [{ id: 'card-native-request', created_time: '2026-11-16T23:00:00Z', text: `Operation: request_decision\nRequested from: Will\nQuestion: ${sampleCommentQuestion}${revision ? ` (revision ${revision})` : ''}\nTin Star request: ${JSON.stringify(request)}` },
        ...comments, ...(options.answered ? [{ id: 'answer-comment', text: `Operation: answer_decision\nAnswer: Defer\nTin Star answer data: ${JSON.stringify({ request_id: sampleCommentRequest, answer: 'Defer', next: { owner: 'Firstmate', status: 'Queued' } })}\nTin Star answer: ${sampleCommentRequest}` }] : [])]
      return Response.json({ results: texts.map(({ text, ...rest }) => ({ ...rest, rich_text: [{ plain_text: job ? text.replace('74fe96a2-8e5b-4045-8e27-1bbabf7d86f0', job) : text }] })), has_more: false })
    },
  })
  const { sources } = fixture
  const preparation = new DecisionPreparation(sources.decisionPackets, 'f'.repeat(32), {
    candidates: cardId => fixture.cardIds.filter(id => id === cardId).flatMap(id => sources.preparationEvidence(id).requests.flatMap(request => request.binding ? [{
      card_id: id, request_id: request.binding.request_id, source_revision: request.binding.source_revision,
      card_url: `https://www.notion.so/${id}`, card_status: 'Waiting For', answered: request.answered, leased: false, reasons: request.reasons, rank: 0,
    }] : [])), coverage: () => 'complete',
  }, id => sources.preparationEvidence(id), async () => JSON.stringify({ url: 'https://prep.example/job', key: 'fixture-key' }),
  Date.now, async () => new Response(null, { status: 202 }))
  const prepare = async (cardId: string) => {
    await sources.updateContext(cardId)
    return preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: sampleCommentRequest, reason: 'Prepare fixture research' })
  }
  if (options.prepare !== false && !options.answered && !options.jobIds) {
    if (fixture.cardIds.length > 3) await sources.decisionPackets.updatePolicy('f'.repeat(32), {
      expected_version: 0, values: { target_ready: 10, max_preparers: 8, automatic_replenishment: false },
    }, 'fixture-owner')
    for (const id of fixture.cardIds) {
      const job = await prepare(id)
      if (!job.job_id) throw new Error(job.explanation)
      jobIds.set(id, job.job_id)
      sources.workflow.onRecordedChange?.(id)
    }
  }
  return { ...fixture, jobIds, prepare, requestId: sampleCommentRequest, setComments: (next: typeof comments) => { comments = next }, changeRequest: () => { revision++ } }
}
