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

it('reads checkpoint comments without a writer and retains body evidence if comments are unavailable', async () => {
  let denied = false
  const fetcher = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/comments') {
      expect(url.searchParams.get('block_id')).toBe('b'.repeat(32))
      return denied ? new Response('', { status: 403 }) : new Response(JSON.stringify({ has_more: false, results: [
        { id: 'comment', rich_text: [{ plain_text: 'Actual dated checkpoint comment' }] },
      ] }))
    }
    return new Response(JSON.stringify({ has_more: false, results: [
      { id: 'paragraph', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Card checkpoint paragraph' }] } },
    ] }))
  }) as unknown as typeof fetch
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  expect((await reader.checkpoints('b'.repeat(32))).blocks).toHaveLength(2)
  denied = true
  expect(await reader.checkpoints('b'.repeat(32))).toMatchObject({ outcome: 'partial', blocks: [{ id: 'paragraph', text: 'Card checkpoint paragraph' }] })
  expect(vi.mocked(fetcher).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})
