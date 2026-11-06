import { expect, it, vi } from 'vitest'
import { notionObservation } from '../../reconciliation/notion'

it('reads the explicit card verification checkbox without changing the Notion schema or card', async () => {
  const id = 'a'.repeat(32)
  const schema = { object: 'data_source', properties: Object.fromEntries(['Name', 'Status', 'Owner', 'Last touched by', 'Will action', 'Parent item', 'Sub-item', 'Link', 'Requires production verification'].map(name => [name, { id: name, type: name === 'Requires production verification' ? 'checkbox' : 'rich_text' }])) }
  const query = { results: [{ object: 'page', id, last_edited_time: '2026-11-06T18:00:00Z', properties: { Name: { type: 'title', title: [{ plain_text: 'Verify this feature' }] }, 'Requires production verification': { type: 'checkbox', checkbox: true } } }], has_more: false }
  const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === 'POST' ? query : schema), { status: 200 }))
  const read = await notionObservation({ token: 'test-token', dataSourceId: id }, fetcher).get()
  expect(read.data!.cards[0]!.properties['Requires production verification']!.value).toBe(true)
  expect(fetcher.mock.calls.every(([url, init]) => init.method === 'GET' || init.method === 'POST' && url.endsWith('/query'))).toBe(true)
})
