import { expect, it, vi } from 'vitest'
import { CardContextReader } from '../cardContext'
it('reads bounded card prose with explicit omissions, coalesces reads and omits code/credential literals', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [
    { id: 'prose', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Commitment: show the actual source. secret_123456789012345678901234' }] } },
    { id: 'code', type: 'code', code: { rich_text: [{ plain_text: 'sensitive raw transcript' }] } },
  ], has_more: false }))) as unknown as typeof fetch
  const reader = new CardContextReader({ token: 'private-config-token', dataSourceId: 'a'.repeat(32) }, fetcher)
  const [one, two] = await Promise.all([reader.get('b'.repeat(32)), reader.get('b'.repeat(32))])
  expect(one).toEqual(two)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(one).toMatchObject({ outcome: 'partial', blocks: [{ id: 'prose', text: 'Commitment: show the actual source. [credential omitted]' }] })
  expect(JSON.stringify(one)).not.toMatch(/private-config-token|sensitive raw transcript|secret_123/)
})
