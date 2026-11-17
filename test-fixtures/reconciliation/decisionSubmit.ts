/** Disposable Notion-compatible source for backend/HTTP preview proof only.
 * No production credentials, board or First Mate bridge is consulted. */
import { preparedDecisionFixture } from './preparedDecision'
import { notionCard } from '../../src/server/reconciliation/notion'
import { NotionApi } from '../../src/server/reconciliation/notionApi'
import { WorkReader } from '../../src/server/reconciliation/workReader'
import { WorkflowOperations } from '../../src/server/reconciliation/workflow'
import { CardLeases } from '../../src/server/reconciliation/cardLeases'
import { type StoredDecisionPacket, DecisionPackets } from '../../src/server/reconciliation/decisionPackets'
import { PreparedReviews } from '../../src/server/reconciliation/preparedReviews'
import { PreparedSubmissions } from '../../src/server/reconciliation/preparedSubmissions'
import { projectPreparedSubmitEvidence } from '../../src/server/reconciliation/decisionEvidence'
import { plainText } from '../../src/server/reconciliation/workflowContent'
import type { SourceSnapshot } from '../../src/server/reconciliation'

export function decisionSubmitFixture(count = 3, now = Date.now()) {
  const fixtures = Array.from({ length: count }, (_, i) => {
    const source = preparedDecisionFixture(now)
    const card = (i + 300).toString(16).padStart(32, '0')
    return JSON.parse(JSON.stringify(source).replaceAll(source.cardId, card)) as typeof source
  })
  const dataSourceId = 'b'.repeat(32)
  const pages = new Map(fixtures.map(f => {
    const card = f.snapshot.intentions.data!.cards.find(card => card.id === f.cardId)!
    const properties = Object.fromEntries(Object.entries(card.properties).map(([name, property]) => {
      const type = property.type || 'rich_text', value = property.value
      const wire = type === 'rich_text' || type === 'title' ? [{ type: 'text', text: { content: String(value ?? '') } }]
        : type === 'multi_select' ? (value as string[] ?? []).map(name => ({ name })) : type === 'select' || type === 'status' ? value === null ? null : { name: value } : value
      return [name, { id: name, type, [type]: wire }]
    }))
    properties.Area ??= { id: 'Area', type: 'select', select: { name: 'Engineering' } }
    properties['Last touched by'] ??= { id: 'Last touched by', type: 'rich_text', rich_text: [] }
    return [f.cardId, { object: 'page', id: f.cardId, parent: { data_source_id: dataSourceId }, url: `https://www.notion.so/${f.cardId}`, last_edited_time: new Date(now).toISOString(), archived: false, in_trash: false, properties }]
  }))
  const comments = new Map(fixtures.map(f => [f.cardId, f.history.context.blocks.map(block => ({ id: block.id, rich_text: [{ text: { content: block.text } }] }))]))
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  const controls = { failReads: false, reject: false, loseProperty: false, loseIntent: false, loseAnswer: false, failAnswer: false,
    queueUnavailable: false, evidenceChanged: false, delayMs: 0 }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    const queryWrite = path.endsWith('/query')
    if (controls.delayMs) await new Promise(resolve => setTimeout(resolve, controls.delayMs))
    if (controls.failReads && (method === 'GET' || queryWrite)) throw new Error('Isolated source unavailable')
    const cardId = path.split('/')[3]!, page = path.startsWith('/v1/pages/') ? pages.get(cardId) : undefined
    if (method !== 'GET' && !queryWrite) {
      writes.push({ path, method, body })
      if (controls.reject) return json({}, 403)
    }
    if (page && method === 'GET') return json(page)
    if (page && method === 'PATCH') {
      for (const [key, value] of Object.entries(body.properties)) page.properties[key] = { id: key, type: Object.keys(value as object)[0]!, ...page.properties[key], ...value as object }
      if (controls.loseProperty) { controls.loseProperty = false; throw new Error('Isolated lost property response') }
      return json(page)
    }
    if (path === '/v1/comments' && method === 'POST') {
      const text = plainText(body.rich_text), notes = comments.get(body.parent.page_id)!
      if (controls.failAnswer && text.includes('\nOperation: answer_decision')) return json({}, 503)
      notes.push({ id: `source-comment-${notes.length}`, rich_text: body.rich_text })
      if (controls.loseIntent && text.startsWith('Tin Star decision intent:')) { controls.loseIntent = false; throw new Error('Isolated lost intent response') }
      if (controls.loseAnswer && text.includes('\nOperation: answer_decision')) { controls.loseAnswer = false; throw new Error('Isolated lost answer response') }
      return json(notes.at(-1))
    }
    if (path === '/v1/comments') return json({ results: comments.get(new URL(String(url)).searchParams.get('block_id')!) ?? [], has_more: false })
    if (path.endsWith('/children')) return json({ results: [], has_more: false })
    if (path === `/v1/data_sources/${dataSourceId}`) return json({ properties: pages.values().next().value!.properties })
    if (queryWrite) return json({ results: [...pages.values()], has_more: false })
    return json({}, 404)
  }
  const build = async (root: string, transport: typeof fetch = fetcher, clock = Date.now) => {
    const leases = new CardLeases(root, clock), packets = new DecisionPackets(leases, clock)
    const reader = new WorkReader({ token: 'isolated-source-only', dataSourceId }, new NotionApi(transport, 0)); reader.leases = leases
    // Only this fixture's explicit home/card bindings are visible to the writer.
    const fleet = structuredClone(fixtures[0]!.snapshot.fleet)
    const snapshot = (): SourceSnapshot => {
      const base = structuredClone(fixtures[0]!.snapshot)
      base.fleet = structuredClone(fleet)
      base.intentions.data!.cards = [...pages.values()].map(notionCard)
      return base
    }
    // Source requests in independent fixture cards use the same synthetic home
    // and task; explicit source card references, not title matching, bind them.
    // Each writer is given the exact fixture's own scoped fleet observation.
    const workflow = (card: string) => {
      const f = fixtures.find(f => f.cardId === card)!
      return new WorkflowOperations(reader, async () => f.snapshot.fleet, root)
    }
    const workflows = new Map(fixtures.map(f => [f.cardId, workflow(f.cardId)]))
    const reviews = new PreparedReviews(packets, 'isolated-submit-board', card => fixtures.find(f => f.cardId === card)!.evidence,
      () => { if (controls.queueUnavailable) throw new Error('Isolated next unavailable'); return { card_ids: fixtures.map(f => f.cardId), coverage: 'complete', requests: fixtures.length } }, clock)
    const source = {
      observe: (input: Parameters<WorkflowOperations['observePreparedAnswer']>[0], actor: string) => workflows.get(input.card_id)!.observePreparedAnswer(input, actor),
      evidence: async (stored: StoredDecisionPacket, original?: Record<string, unknown>, desired?: Record<string, unknown>, ownIntentId?: string) => {
        const f = fixtures.find(f => f.cardId === stored.packet.binding.card_id)!
        const current = snapshot(); current.fleet = f.snapshot.fleet
        const history = await workflows.get(f.cardId)!.preparedHistory(f.cardId)
        const evidence = projectPreparedSubmitEvidence(current, f.cardId, history.filter(note => note.id !== ownIntentId), original, desired, clock())
        if (controls.evidenceChanged) evidence.requests[0]!.binding!.source_revision = 'changed'
        return evidence
      },
      write: (input: Parameters<WorkflowOperations['answerPrepared']>[0], actor: string) => workflows.get(input.card_id)!.answerPrepared(input, actor),
    }
    const submissions = new PreparedSubmissions(reviews, source, clock)
    for (const [i, f] of fixtures.entries()) {
      await packets.publish(f.packet, f.evidence, 'isolated-fixture', `packet-${i}`)
    }
    return { leases, packets, reader, reviews, submissions, workflows, source, snapshot }
  }
  return { fixtures, pages, comments, writes, controls, fetcher, build, dataSourceId }
}
