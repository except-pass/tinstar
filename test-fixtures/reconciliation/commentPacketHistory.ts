/** Real comment format against a disposable, card-native request and stub Notion
 * transport. No production credentials, source writes, or webhook are used. */
import { readFileSync } from 'node:fs'
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

export async function commentPacketHistoryFixture(root: string, options: { answered?: boolean; packet?: string; cards?: number } = {}) {
  let comments = [{ id: 'sample-packet-comment', text: options.packet ?? sampleCommentPacket, created_time: '2026-11-16T23:40:00Z' }]
  let revision = 0
  const fixture = await preparationHistoryFixture(root, async () => null, { cards: options.cards,
    wrapFetch: fixtureFetch => async (input, init) => {
      const url = new URL(String(input))
      const response = await fixtureFetch(input, init)
      if (url.pathname !== '/v1/comments' || (init?.method ?? 'GET') !== 'GET') return response
      const request = { id: sampleCommentRequest, action: 'Decision', preserve_action: false, options: sampleCommentOptions }
      const texts = [{ id: 'card-native-request', created_time: '2026-11-16T23:00:00Z', text: `Operation: request_decision\nRequested from: Will\nQuestion: ${sampleCommentQuestion}${revision ? ` (revision ${revision})` : ''}\nTin Star request: ${JSON.stringify(request)}` },
        ...comments, ...(options.answered ? [{ id: 'answer-comment', text: `Operation: answer_decision\nAnswer: Defer\nTin Star answer data: ${JSON.stringify({ request_id: sampleCommentRequest, answer: 'Defer', next: { owner: 'Firstmate', status: 'Queued' } })}\nTin Star answer: ${sampleCommentRequest}` }] : [])]
      return Response.json({ results: texts.map(({ text, ...rest }) => ({ ...rest, rich_text: [{ plain_text: text }] })), has_more: false })
    },
  })
  return { ...fixture, requestId: sampleCommentRequest, setComments: (next: typeof comments) => { comments = next }, changeRequest: () => { revision++ } }
}
