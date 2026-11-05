import { CachedObservation } from './observation'
import { record, text } from './values'
import { FIRST_MATE_TASKS, readWorkerLinks, type WorkerLinks } from './workerLinks'
import type { ReconciliationConfig } from './config'

// Malformed hyphen strings must not normalize into supposedly canonical links.
const UUID = /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/
export const notionPageId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.replaceAll('-', '').toLowerCase() : null
const PROPERTY_NAMES = [
  'Name', 'Status', 'Owner', 'Last touched by', 'Will action', 'Parent item', 'Sub-item',
  'Link', 'Waiting For', 'Delegated To', 'Next check-in', 'Due Date', 'Start Date', 'Priority', 'Area', 'Sub-area', 'Attention',
  'Next action', 'Next Action', 'Evidence', 'Initiative', 'Epic', FIRST_MATE_TASKS,
]

function property(value: unknown, name: string): { id: string | null; type: string | null; value: unknown; hasMore: boolean; workerLinks?: WorkerLinks } {
  const p = record(value)
  const type = text(p.type)
  let result: unknown = null
  if (type === 'select' || type === 'status') result = text(record(p[type]).name)
  else if (type === 'multi_select') result = Array.isArray(p.multi_select) ? p.multi_select.map(v => text(record(v).name)).filter(Boolean) : null
  else if (type === 'title' || type === 'rich_text') result = Array.isArray(p[type])
    ? p[type].map(v => text(record(v).plain_text) ?? text(record(record(v).text).content) ?? '').join('') : null
  else if (type === 'relation') result = Array.isArray(p.relation) ? p.relation.map(v => notionPageId(record(v).id)).filter(Boolean) : null
  else if (type === 'url') result = text(p.url)
  else if (type === 'date') result = p.date === null ? null : { start: text(record(p.date).start), end: text(record(p.date).end), time_zone: text(record(p.date).time_zone) }
  return { id: text(p.id), type, value: result, hasMore: p.has_more === true,
    ...(name === FIRST_MATE_TASKS ? { workerLinks: readWorkerLinks(value) } : {}) }
}

function card(value: unknown) {
  const p = record(value)
  const id = notionPageId(p.id)
  if (!id || typeof p.last_edited_time !== 'string' || !p.properties || p.object !== 'page') throw new Error('invalid Notion page')
  const properties = record(p.properties)
  return {
    id, url: text(p.url), last_edited_time: p.last_edited_time,
    archived: p.archived === true, in_trash: p.in_trash === true,
    properties: Object.fromEntries(PROPERTY_NAMES.filter(name => name in properties).map(name => [name, property(properties[name], name)])),
  }
}

export function notionObservation(config: ReconciliationConfig['notion'], fetcher: typeof fetch = fetch) {
  return new CachedObservation(async () => {
    if (!config) throw new Error('Notion is not configured')
    // One deadline across schema + pagination; no retries on the UI read path.
    const signal = AbortSignal.timeout(20_000)
    async function request(path: string, body?: unknown) {
      const response = await fetcher(`https://api.notion.com/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${config!.token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error('Notion request failed')
      // Bound bytes too, rather than trusting remote Content-Length.
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Notion response missing')
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 4 * 1024 * 1024) throw new Error('Notion response too large')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    }
    const path = `data_sources/${config.dataSourceId}`
    const schema = await request(path)
    if (!schema.properties || schema.object !== 'data_source') throw new Error('invalid Notion schema')
    const schemaProperties = record(schema.properties)
    const properties = Object.fromEntries(Object.entries(schemaProperties).map(([name, value]) => {
      const p = record(value)
      const sourceOptions = record(p[String(p.type)]).options
      const options = ['select', 'status'].includes(String(p.type)) && Array.isArray(sourceOptions)
        ? sourceOptions.map(option => text(record(option).name)).filter((name): name is string => !!name) : []
      return [name, { id: text(p.id), type: text(p.type), options, relation: p.type === 'relation'
        ? { data_source_id: notionPageId(record(p.relation).data_source_id), database_id: notionPageId(record(p.relation).database_id) } : null }]
    }))
    const cards = new Map<string, ReturnType<typeof card>>()
    let cursor: string | undefined
    let hasMore = false
    for (let page = 0; page < 10; page++) {
      const response = await request(`${path}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
      if (!Array.isArray(response.results) || typeof response.has_more !== 'boolean') throw new Error('invalid Notion query')
      for (const value of response.results) {
        const item = card(value)
        cards.set(item.id, item)
      }
      hasMore = response.has_more
      if (!hasMore) break
      const next = text(response.next_cursor)
      if (!next || next === cursor) throw new Error('invalid Notion cursor')
      cursor = next
    }
    const items = [...cards.values()]
    // Notion inlines at most 25 relation ids. Follow each has_more relation so a
    // finished card query can still report complete coverage. Cap the follow-up
    // at 10 pages per property and 20 requests per refresh: this read shares one
    // 20s deadline, and uncapped paging would blow that deadline. A read that
    // fails or hits either cap keeps the inline list and names the card/property.
    const relationBudget = { remaining: 20 }
    async function completeRelation(pageId: string, propertyId: string): Promise<string[] | null> {
      const ids: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        if (relationBudget.remaining <= 0) return null
        relationBudget.remaining -= 1
        const query = new URLSearchParams({ page_size: '100' })
        if (cursor) query.set('start_cursor', cursor)
        let body: Record<string, unknown>
        try {
          body = await request(`pages/${pageId}/properties/${encodeURIComponent(propertyId)}?${query}`)
        } catch {
          return null
        }
        if (!Array.isArray(body.results) || typeof body.has_more !== 'boolean') return null
        for (const value of body.results) {
          const row = record(value)
          if (row.type !== 'relation') return null
          const relationId = notionPageId(record(row.relation).id) ?? notionPageId(row.id)
          if (!relationId) return null
          ids.push(relationId)
        }
        if (!body.has_more) return ids
        const next = text(body.next_cursor)
        if (!next || next === cursor) return null
        cursor = next
      }
      return null
    }
    for (const item of items) {
      for (const prop of Object.values(item.properties)) {
        if (prop.type !== 'relation' || !prop.hasMore || !prop.id) continue
        const ids = await completeRelation(item.id, prop.id)
        if (!ids) continue
        prop.value = ids
        prop.hasMore = false
      }
    }
    const truncatedRelations = items.flatMap(item => Object.entries(item.properties)
      .filter(([, p]) => p.hasMore).map(([name]) => ({ pageId: item.id, property: name })))
    const missingSchemaProperties = ['Name', 'Status', 'Owner', 'Last touched by', 'Will action', 'Parent item', 'Sub-item', 'Link']
      .filter(name => !(name in properties))
    const partial = hasMore || truncatedRelations.length > 0 || missingSchemaProperties.length > 0
    return {
      observedAt: new Date().toISOString(), coverage: partial ? 'partial' as const : 'complete' as const,
      data: { dataSourceId: notionPageId(config.dataSourceId), schema: properties, cards: items,
        hasMore, truncatedRelations, missingSchemaProperties,
        scope: 'configured-data-source-properties; card bodies and related external sources not collected' },
    }
  }, 60_000, 120_000, config ? 'Notion read failed or returned an unsupported response; verify token access and data source' : 'Notion token and dataSourceId are not configured')
}
