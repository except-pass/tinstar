/** Real source readers over synthetic Notion pages/comments and published fleet
 * files. All storage and source identities belong to the caller's temp root. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preparedDecisionFixture } from './preparedDecision'
import { ReconciliationSources } from '../../src/server/reconciliation'
import { NotionApi } from '../../src/server/reconciliation/notionApi'
import type { ReconciliationConfig } from '../../src/server/reconciliation/config'

export async function preparationHistoryFixture(root: string, secret: () => Promise<string | null> = async () => null, options: {
  cards?: number; onRead?: () => void; beforeRead?: (url: URL) => Promise<void>; intervalMs?: number; cardStatus?: 'Queued' | 'Waiting For'
  answered?: boolean; independentRequest?: boolean; waitPadding?: string; inactiveWait?: string
  largeContract?: boolean; historySurface?: 'comments' | 'body' | 'none'; commentCount?: number
  wrapFetch?: (fixtureFetch: typeof fetch) => typeof fetch
} = {}) {
  const createdAt = new Date().toISOString()
  const fixture = preparedDecisionFixture()
  const card = fixture.snapshot.intentions.data!.cards.find(card => card.id === fixture.cardId)!
  card.properties.Area = { id: 'Area', type: 'select', value: 'Engineering', hasMore: false }
  card.properties.Status!.value = options.cardStatus ?? 'Waiting For'
  if (card.properties.Status!.value === 'Waiting For') for (const [name, value] of Object.entries({ Owner: 'Will', 'Waiting For': 'Will: Choose the bounded preview route?' + (options.waitPadding ?? ''), 'Waiting For Type': 'Actor', 'Waiting For ID': 'Will' })) {
    card.properties[name] = { id: name, type: name === 'Waiting For' ? 'rich_text' : 'select', value, hasMore: false }
  }
  if (options.inactiveWait) {
    card.properties['Waiting For'] = { id: 'Waiting For', type: 'rich_text', value: options.inactiveWait, hasMore: false }
    card.properties['Waiting For Type'] = { id: 'Waiting For Type', type: 'select', value: null, hasMore: false }
    card.properties['Waiting For ID'] = { id: 'Waiting For ID', type: 'select', value: null, hasMore: false }
    card.properties['Next check-in'] = { id: 'Next check-in', type: 'date', value: null, hasMore: false }
  }
  const dataSourceId = 'f'.repeat(32)
  const homes = fixture.snapshot.fleet.map((home, index) => ({ ...home, source: { ...home.source, home: join(root, `home-${index}`) } }))
  let historyText = fixture.history.context.blocks[0]!.text
  for (const [index, home] of fixture.snapshot.fleet.entries()) historyText = historyText.replaceAll(home.source.home, homes[index]!.source.home)
  const extraNotes: string[] = []
  const publishedNotes: Array<{ id: string; cardId: string; rich_text: unknown[]; created_time?: string }> = []
  if (options.answered) extraNotes.push(`Operation: answer_decision\nAnswer: Defer the preview.\nNext owner: Firstmate\nNext status: Queued\nTin Star answer data: ${JSON.stringify({ request_id: 'preview-question', answer: 'Defer the preview.', next: { owner: 'Firstmate', status: 'Queued' } })}\nTin Star answer: preview-question`)
  if (options.independentRequest) {
    const home = homes[1]!, task = home.observation.data!.tasks[0]!
    const question = 'Approve an independent bounded audit?'
    task.queue!.decisions.push({ key: 'independent-go', verb: 'needs-decision', summary: question })
    const hold = home.observation.data!.backlog!.find(row => row.id === 'preview-go')!
    home.observation.data!.backlog!.push({ ...hold, id: 'independent-go', title: question, hold_reason: question })
    extraNotes.push(`Operation: request_decision\nRequested from: Will\nQuestion: ${question}\nTin Star request: ${JSON.stringify({ id: 'independent-question', action: 'Decision', preserve_action: false,
      source_request: { home: home.source.home, taskId: task.id, id: 'independent-go', kind: 'decision' }, source_question: question, source_spawn_gen: task.identity.spawn_gen })}`)
  }
  card.properties['Last touched by'] = { id: 'Last touched by', type: 'select', value: 'Fixture publisher', hasMore: false }
  const properties: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(card.properties).map(([name, prop]) => {
    const value = prop.value
    const type = name === 'Next check-in' ? 'date' : name === 'Name' ? 'title' : name === 'Status' ? 'status' : name === 'First Mate tasks' || name === 'Next action' || name === 'Waiting For' ? 'rich_text' : Array.isArray(value) ? name === 'Will action' ? 'multi_select' : 'relation' : 'select'
    const content = type === 'title' || type === 'rich_text' ? [{ plain_text: String(value), text: { content: String(value) } }]
      : type === 'multi_select' ? (value as string[]).map(name => ({ name }))
      : type === 'relation' ? (value as string[]).map(id => ({ id })) : value === null ? null : { name: value }
    return [name, { id: name, type, [type]: content }]
  }))
  // The source requires these board schema fields even if a page leaves them empty.
  const schema = { ...properties, 'Last touched by': { type: 'select' }, 'Sub-item': { type: 'relation' }, Link: { type: 'url' } }
  const raw = { object: 'page', id: card.id, url: card.url, parent: { type: 'data_source_id', data_source_id: dataSourceId },
    archived: false, in_trash: false, last_edited_time: new Date().toISOString(), properties }
  const titles = ['Approve staged API rollout', 'Choose audit retention period', 'Authorize bounded migration rehearsal', 'Review incident recovery plan', 'Confirm release verification scope', 'Select queue backpressure policy', 'Approve dashboard access change', 'Choose dependency upgrade timing']
  const pages: Array<typeof raw> = Array.from({ length: options.cards ?? 1 }, (_, index) => index === 0 ? raw : { ...raw, id: (index + 100).toString(16).padStart(32, '0'), properties: {
    ...properties, Name: { id: 'Name', type: 'title', title: [{ plain_text: `${titles[index % titles.length]} · ${index + 1}` }] },
    'First Mate tasks': { id: 'First Mate tasks', type: 'rich_text', rich_text: [] },
  } })
  const reads: Array<{ path: string; method: string }> = []
  let commentsAvailable = true
  let requestText = historyText
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    options.onRead?.()
    reads.push({ path: url.pathname, method })
    await options.beforeRead?.(url)
    if (url.origin !== 'https://api.notion.com') throw new Error('Fixture transport only supports synthetic Notion reads')
    if (url.pathname === `/v1/data_sources/${dataSourceId}` && method === 'GET') return Response.json({ object: 'data_source', properties: schema })
    if (url.pathname === `/v1/data_sources/${dataSourceId}/query` && method === 'POST') return Response.json({ results: pages, has_more: false })
    const page = pages.find(page => url.pathname === `/v1/pages/${page.id}`)
    if (page && method === 'GET') return Response.json(page)
    if (page && method === 'PATCH') {
      const input = JSON.parse(String(init?.body))
      for (const [name, value] of Object.entries(input.properties)) page.properties[name] = { ...page.properties[name], ...(value as object) }
      page.last_edited_time = new Date().toISOString()
      return Response.json(page)
    }
    if (url.pathname === '/v1/comments' && method === 'POST') {
      const input = JSON.parse(String(init?.body))
      const note = { id: `published-comment-${publishedNotes.length}`, cardId: input.parent.page_id, rich_text: input.rich_text, created_time: new Date().toISOString() }
      publishedNotes.push(note)
      return Response.json(note)
    }
    if (pages.some(page => url.pathname === `/v1/blocks/${page.id}/children`) && method === 'GET') {
      const offset = Number(url.searchParams.get('start_cursor') ?? 0)
      const count = options.largeContract ? 1205 : 1
      const results = Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
        const number = offset + index
        if (number === count - 1 && options.historySurface === 'body') return { id: 'legacy-body-request', type: 'paragraph', paragraph: { rich_text: [{ plain_text: requestText }] } }
        if (options.largeContract && number % 3 === 0) return { id: `contract-${number}`, type: 'code', code: { rich_text: [{ plain_text: 'Implementation contract chunk: isolated specification evidence.' }] } }
        if (options.largeContract && number % 3 === 1) return { id: `nested-spec-${number}`, type: 'toggle', has_children: true, toggle: { rich_text: [{ plain_text: 'Nested implementation details, not a workflow publication' }] } }
        return { id: `background-${number}`, type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Decision background in the card body.' }] } }
      })
      return Response.json({ results, has_more: offset + results.length < count, next_cursor: String(offset + results.length) })
    }
    // General card prose traverses nested specs; workflow publication reads do not.
    if (url.pathname.startsWith('/v1/blocks/nested-spec-')) return Response.json({ results: [], has_more: false })
    if (url.pathname === '/v1/comments' && method === 'GET' && pages.some(page => url.searchParams.get('block_id') === page.id)) {
      if (!commentsAvailable) return new Response('', { status: 403 })
      const offset = Number(url.searchParams.get('start_cursor') ?? 0)
      const texts = [...Array.from({ length: options.commentCount ?? 0 }, () => 'A historical status note.'),
        ...(options.historySurface === 'none' || options.historySurface === 'body' ? [] : [requestText]), ...extraNotes]
      const comments = [...texts.map((text, index) => ({ id: `request-comment-${index}`, created_time: createdAt, rich_text: [{ plain_text: text }] })), ...publishedNotes.filter(note => note.cardId === url.searchParams.get('block_id'))]
      return Response.json({ results: comments.slice(offset, offset + 100), has_more: offset + 100 < comments.length, next_cursor: String(offset + 100) })
    }
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
  const fetcher = options.wrapFetch?.(fixtureFetch) ?? fixtureFetch
  const sources = new ReconciliationSources(config, fetcher, new NotionApi(fetcher, options.intervalMs ?? 0), root, secret)
  await sources.snapshot()
  return { sources, cardId: card.id, cardIds: pages.map(page => page.id), requestId: 'preview-question', reads, config,
    sourceRequest: { home: homes[1]!.source.home, taskId: 'linked-worker', id: 'preview-go', kind: 'decision' as const },
    publishedNotes,
    denyComments: () => { commentsAvailable = false },
    allowComments: () => { commentsAvailable = true },
    removeOptions: () => { requestText = historyText.replace(/,"options":\[.*\]/, '') },
    removeBinding: () => { requestText = historyText.replace(/"source_request":\{[^}]+\},/, '') },
    removeRequest: () => { requestText = 'A status update without a recorded decision request.' },
  }
}
