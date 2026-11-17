import { expect, it, vi } from 'vitest'
import { CardContextReader } from '../cardContext'
it.each(['body', 'comments'])('retains known answer blocks for claims when only %s history has loaded', async first => {
  const fetcher = vi.fn(async () => Response.json({ results: [{ id: 'answer', type: 'paragraph',
    paragraph: { rich_text: [{ plain_text: 'Tin Star answer: "decision"' }] },
    rich_text: [{ plain_text: 'Tin Star answer: "decision"' }],
  }], has_more: false }))
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  if (first === 'body') await reader.get('card')
  else await reader.commentDetails('card')
  fetcher.mockClear()
  expect(reader.cachedDecisionHistory('card')).toBeUndefined()
  expect(reader.cachedClaimBlocks('card')).toContainEqual(expect.objectContaining({ id: 'answer', text: 'Tin Star answer: "decision"' }))
  expect(fetcher).not.toHaveBeenCalled()
})

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
        { id: 'comment', created_time: '2026-11-10T02:24:00Z', rich_text: [{ plain_text: 'Actual dated checkpoint comment' }] },
      ] }))
    }
    return new Response(JSON.stringify({ has_more: false, results: [
      { id: 'paragraph', last_edited_time: '2026-11-10T02:25:00Z', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Card checkpoint paragraph' }] } },
    ] }))
  }) as unknown as typeof fetch
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  expect((await reader.checkpoints('b'.repeat(32))).blocks).toMatchObject([
    { id: 'paragraph', last_edited_time: '2026-11-10T02:25:00Z' },
    { id: 'comment', created_time: '2026-11-10T02:24:00Z' },
  ])
  denied = true
  expect(await reader.checkpoints('b'.repeat(32))).toMatchObject({ outcome: 'partial', blocks: [{ id: 'paragraph', text: 'Card checkpoint paragraph' }] })
  expect(vi.mocked(fetcher).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('retains the older body or comment expiry without refreshing cached history', async () => {
  const start = Date.parse('2026-11-15T18:00:00Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  try {
    for (const first of ['body', 'comments']) {
      clock.mockReturnValue(start)
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [], has_more: false })))
      const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
      if (first === 'body') await reader.get('card')
      else await reader.commentDetails('card')
      expect(reader.cachedDecisionHistory('card')).toBeUndefined()
      clock.mockReturnValue(start + 10_000)
      if (first === 'body') await reader.commentDetails('card')
      else await reader.get('card')
      fetcher.mockClear()
      clock.mockReturnValue(start + 31_000)
      expect(reader.cachedDecisionHistory('card')).toMatchObject({
        observed_at: new Date(start).toISOString(), expires_at: new Date(start + 30_000).toISOString(),
        context: { outcome: 'available', commentsOutcome: 'available', blocks: [] },
      })
      expect(fetcher).not.toHaveBeenCalled()
    }
  } finally { clock.mockRestore() }
})

it('coalesces a pending history read even after its freshness deadline has passed', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve }))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  try {
    const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
    const first = reader.get('card')
    clock.mockReturnValue(135_000)
    expect(reader.get('card')).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    finish(Response.json({ results: [], has_more: false }))
    await first
    expect(reader.cachedDecisionHistory('card')).toBeUndefined()
  } finally { clock.mockRestore() }
})

it('retains known history with its original expired timestamps while a refresh is pending', async () => {
  const start = Date.parse('2026-11-16T20:00:00Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  let release!: () => void, slow = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher: typeof fetch = async () => {
    if (slow) await gate
    return Response.json({ results: [], has_more: false })
  }
  try {
    const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
    await reader.details('card')
    const original = reader.cachedDecisionHistory('card')
    slow = true
    clock.mockReturnValue(start + 31_000)
    const refresh = reader.details('card')
    expect(reader.cachedDecisionHistory('card')).toEqual(original)
    expect(Date.parse(reader.cachedDecisionHistory('card')!.expires_at)).toBeLessThan(Date.now())
    expect(reader.cachedComments('card')).toBeUndefined()
    release()
    await refresh
    expect(Date.parse(reader.cachedDecisionHistory('card')!.expires_at)).toBe(start + 61_000)
  } finally { release(); clock.mockRestore() }
})

it('keeps a decision read fresh after a 25-second source delay while retaining its original observation time', async () => {
  vi.useFakeTimers()
  try {
    const start = Date.now()
    const fetcher: typeof fetch = async () => {
      await new Promise(resolve => setTimeout(resolve, 25_000))
      return Response.json({ results: [], has_more: false })
    }
    const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
    const read = reader.decisionDetails('card')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await read).toMatchObject({ outcome: 'available', commentsOutcome: 'available' })
    expect(reader.cachedDecisionHistory('card')).toMatchObject({ observed_at: new Date(start).toISOString(), expires_at: new Date(start + 30_000).toISOString() })
  } finally { vi.useRealTimers() }
})

it.each(['body', 'comments'])('does not certify missing or looping %s pagination', async source => {
  const fetcher: typeof fetch = async input => {
    const target = new URL(String(input)).pathname === '/v1/comments' ? 'comments' : 'body'
    return Response.json({ results: [], has_more: target === source, next_cursor: target === source ? 'same-cursor' : null })
  }
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  expect(await reader.decisionDetails('card')).toMatchObject({ outcome: 'partial', commentsOutcome: source === 'comments' ? 'partial' : 'available' })
})

it('retries a throttled history page through shared Notion Retry-After pacing', async () => {
  const { NotionApi } = await import('../notionApi')
  vi.useFakeTimers()
  try {
    const attempts: number[] = []
    const fetcher: typeof fetch = async input => {
      if (new URL(String(input)).pathname === '/v1/comments') {
        attempts.push(Date.now())
        if (attempts.length === 1) return new Response('', { status: 429, headers: { 'Retry-After': '1' } })
      }
      return Response.json({ results: [], has_more: false })
    }
    const api = new NotionApi(fetcher, 350)
    const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, api.backgroundFetch)
    const pending = reader.decisionDetails('card')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ outcome: 'available', commentsOutcome: 'available' })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1000)
    expect(api.diagnostics.rateLimits).toBe(1)
  } finally { vi.useRealTimers() }
})

it.each(['body', 'comments'] as const)('retains known %s answers from complete publication reads for claims', async surface => {
  const fetcher: typeof fetch = async input => {
    const comments = new URL(String(input)).pathname === '/v1/comments'
    if (comments !== (surface === 'comments')) return Response.json({ results: [], has_more: false })
    const text = 'Tin Star answer: "decision"'
    return Response.json({ results: [{ id: 'answer', type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] }, rich_text: [{ plain_text: text }] }], has_more: false })
  }
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  await reader.decisionDetails('card')
  expect(reader.cachedClaimBlocks('card')).toContainEqual(expect.objectContaining({ id: 'answer', text: 'Tin Star answer: "decision"' }))
})

it('retains a known comment answer for claims when the publication body read fails', async () => {
  const fetcher: typeof fetch = async input => new URL(String(input)).pathname === '/v1/comments'
    ? Response.json({ results: [{ id: 'answer', rich_text: [{ plain_text: 'Tin Star answer: "decision"' }] }], has_more: false })
    : new Response('', { status: 503 })
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  expect(await reader.decisionDetails('card')).toMatchObject({ outcome: 'partial', commentsOutcome: 'available', omissions: 'Card body history read failed (HTTP 503).' })
  expect(reader.cachedClaimBlocks('card')).toContainEqual(expect.objectContaining({ id: 'answer', text: 'Tin Star answer: "decision"' }))
  expect(reader.cachedDecisionHistory('card')?.context).toMatchObject({ outcome: 'partial', commentsOutcome: 'available',
    blocks: [expect.objectContaining({ id: 'answer', text: 'Tin Star answer: "decision"' })] })
})

it.each(['http', 'transport', 'cursor'] as const)('retains legacy answer paragraphs before a later body-page %s failure', async failure => {
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/comments') return Response.json({ results: [], has_more: false })
    if (url.searchParams.has('start_cursor')) {
      if (failure === 'http') return new Response('', { status: 503 })
      if (failure === 'transport') throw new Error('Connection lost')
      return Response.json({ results: [], has_more: true, next_cursor: 'next-page' })
    }
    return Response.json({ results: [{ id: 'legacy-answer', type: 'paragraph',
      paragraph: { rich_text: [{ plain_text: 'Tin Star answer: "decision"' }] },
    }], has_more: true, next_cursor: 'next-page' })
  }
  const reader = new CardContextReader({ token: 'fake', dataSourceId: 'a'.repeat(32) }, fetcher)
  expect(await reader.decisionDetails('card')).toMatchObject({ outcome: 'partial', commentsOutcome: 'available',
    blocks: [expect.objectContaining({ id: 'legacy-answer', text: 'Tin Star answer: "decision"' })] })
  expect(reader.cachedClaimBlocks('card')).toContainEqual(expect.objectContaining({ id: 'legacy-answer' }))
  expect(reader.cachedDecisionHistory('card')?.context.outcome).toBe('partial')
})
