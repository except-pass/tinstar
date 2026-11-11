// Read-only schema receipt using Tin Star's existing configured Notion integration.
// No page content, property values, token or whole config is emitted.
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { join } from 'node:path'

const { values } = parseArgs({ options: {
  'config-root': { type: 'string' }, 'card-id': { type: 'string' },
} })
if (!values['config-root']) throw new Error('Supply the existing authorized Tin Star --config-root')
const config = JSON.parse(await readFile(join(values['config-root'], 'config.json'), 'utf8')).reconciliation?.notion
if (!config?.dataSourceId || !config?.token) throw new Error('Configured Notion integration unavailable')
const receipts = []
async function get(path) {
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03' },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  })
  receipts.push({ method: 'GET', path, status: response.status })
  if (!response.ok) throw new Error(`Notion schema observation failed: HTTP ${response.status}`)
  return response.json()
}
const schema = await get(`data_sources/${config.dataSourceId}`)
const properties = Object.entries(schema.properties ?? {}).map(([name, property]) => ({
  name, id: property.id, type: property.type,
  ...(['status', 'select', 'multi_select'].includes(property.type) ? {
    options: (property[property.type]?.options ?? []).map(({ id, name }) => ({ id, name })),
    ...(property.type === 'status' ? { groups: property.status?.groups } : {}),
  } : {}),
  ...(property.type === 'relation' ? { relation: property.relation } : {}),
}))
let card
if (values['card-id']) {
  // Match the application's 350 ms request pacing. Never retry writes (none here).
  await new Promise(resolve => setTimeout(resolve, 350))
  const page = await get(`pages/${values['card-id']}`)
  if (String(page.parent?.data_source_id).replaceAll('-', '') !== String(schema.id).replaceAll('-', '')) {
    throw new Error('Requested card is outside the configured source')
  }
  card = { id: page.id, url: page.url, last_edited_time: page.last_edited_time,
    archived: page.archived, in_trash: page.in_trash, parent: page.parent,
    properties: Object.entries(page.properties ?? {}).map(([name, property]) => ({ name, id: property.id, type: property.type })),
  }
}
console.log(JSON.stringify({ observed_at: new Date().toISOString(), mode: 'live-read-only',
  data_source_id: schema.id, properties, ...(card ? { card } : {}), receipts }, null, 2))
