/** Real source readers over synthetic Notion pages/comments and published fleet
 * files. All storage and source identities belong to the caller's temp root. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preparedDecisionFixture } from './preparedDecision'
import { ReconciliationSources } from '../../src/server/reconciliation'
import { NotionApi } from '../../src/server/reconciliation/notionApi'
import type { ReconciliationConfig } from '../../src/server/reconciliation/config'

export async function preparationHistoryFixture(root: string, secret: () => Promise<string | null> = async () => null) {
  const fixture = preparedDecisionFixture()
  const card = fixture.snapshot.intentions.data!.cards.find(card => card.id === fixture.cardId)!
  card.properties.Status!.value = 'Waiting For'
  const dataSourceId = 'f'.repeat(32)
  const homes = fixture.snapshot.fleet.map((home, index) => ({ ...home, source: { ...home.source, home: join(root, `home-${index}`) } }))
  let historyText = fixture.history.context.blocks[0]!.text
  for (const [index, home] of fixture.snapshot.fleet.entries()) historyText = historyText.replaceAll(home.source.home, homes[index]!.source.home)
  const properties = Object.fromEntries(Object.entries(card.properties).map(([name, prop]) => {
    const value = prop.value
    const type = name === 'Name' ? 'title' : name === 'Status' ? 'status' : name === 'First Mate tasks' || name === 'Next action' ? 'rich_text' : Array.isArray(value) ? name === 'Will action' ? 'multi_select' : 'relation' : 'select'
    const content = type === 'title' || type === 'rich_text' ? [{ plain_text: String(value), text: { content: String(value) } }]
      : type === 'multi_select' ? (value as string[]).map(name => ({ name }))
      : type === 'relation' ? (value as string[]).map(id => ({ id })) : { name: value }
    return [name, { id: name, type, [type]: content }]
  }))
  // The source requires these board schema fields even if a page leaves them empty.
  const schema = { ...properties, 'Last touched by': { type: 'select' }, 'Sub-item': { type: 'relation' }, Link: { type: 'url' } }
  const raw = { object: 'page', id: card.id, url: card.url, archived: false, in_trash: false, last_edited_time: new Date().toISOString(), properties }
  const reads: Array<{ path: string; method: string }> = []
  let commentsAvailable = true
  let requestText = historyText
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    reads.push({ path: url.pathname, method })
    if (url.origin !== 'https://api.notion.com') throw new Error('Fixture transport only supports synthetic Notion reads')
    if (url.pathname === `/v1/data_sources/${dataSourceId}` && method === 'GET') return Response.json({ object: 'data_source', properties: schema })
    if (url.pathname === `/v1/data_sources/${dataSourceId}/query` && method === 'POST') return Response.json({ results: [raw], has_more: false })
    if (url.pathname === `/v1/blocks/${card.id}/children` && method === 'GET') return Response.json({ results: [{ id: 'background', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Decision background in the card body.' }] } }], has_more: false })
    if (url.pathname === '/v1/comments' && method === 'GET' && url.searchParams.get('block_id') === card.id) return commentsAvailable
      ? Response.json({ results: [{ id: 'request-comment', rich_text: [{ plain_text: requestText }] }], has_more: false })
      : new Response('', { status: 403 })
    throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`)
  }
  const fleet = []
  for (const [index, home] of homes.entries()) {
    const data = home.observation.data!, snapshotFile = join(root, `fleet-${index}.json`)
    const wire = { schema: data.schema, fm_home: home.source.home, generated: new Date().toISOString(), main_inventory: { valid: true },
      tasks: data.tasks.map(task => ({ ...task, notion_page_id: task.cardReferences[0]?.pageId,
        hints: { open_decisions: task.queue?.decisions }, paths: {}, spawn_gen: task.identity.spawn_gen })),
      backlog: { present: true, records: data.backlog!.map(row => ({ ...row, notion_page_id: row.cardReferences[0]?.pageId,
        hold_kind: row.queue?.holdKind, body_lines: row.queue?.originTaskId ? [`Origin: ${row.queue.originTaskId}`] : [] })) } }
    await writeFile(snapshotFile, JSON.stringify(wire))
    fleet.push({ home: home.source.home, snapshotFile })
  }
  const config: ReconciliationConfig = { fleet, notion: { dataSourceId, token: 'isolated-history-fixture-token' }, warnings: [] }
  const sources = new ReconciliationSources(config, fetcher, new NotionApi(fetcher, 0), root, secret)
  await sources.snapshot()
  return { sources, cardId: card.id, requestId: 'preview-question', reads, config,
    denyComments: () => { commentsAvailable = false },
    allowComments: () => { commentsAvailable = true },
    removeOptions: () => { requestText = historyText.replace(/,"options":\[.*\]/, '') },
    removeBinding: () => { requestText = historyText.replace(/"source_request":\{[^}]+\},/, '') },
  }
}
