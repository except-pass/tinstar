import { describe, expect, it, vi } from 'vitest'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { SearchDocumentCollector } from '../searchIndex'
import { CardContextReader } from '../cardContext'

describe('authorized bounded search prose enrichment', () => {
  it('invalidates the prose-reader TTL when the observed Notion revision changes', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ results: [{ id: 'block', type: 'paragraph', paragraph: { rich_text: [{ plain_text: `Revision ${fetcher.mock.calls.length}` }] } }], has_more: false })))
    const reader = new CardContextReader({ dataSourceId: '00000000000000000000000000000001', token: 'fixture-only' }, fetcher)
    const first = await reader.get('authorized-card', 'revision-1')
    expect((await reader.get('authorized-card', 'revision-1')).blocks).toEqual(first.blocks)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await reader.get('authorized-card', 'revision-2')).blocks[0]!.text).toBe('Revision 2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('returns metadata immediately, bounds background reads, and publishes sanitized provenance', async () => {
    let now = Date.parse('2026-11-06T00:00:00Z')
    const scene = fixtureScene({ now })
    const read = vi.fn().mockResolvedValue({ outcome: 'available', observedAt: new Date(now).toISOString(), blocks: [{ text: 'HaveNoPermission secret_12345678901234567890' }] })
    const collector = new SearchDocumentCollector(read, () => now)
    const first = collector.get(scene)
    expect(first.documents.length).toBe(scene.cards.length + scene.executions.length)
    expect(read).toHaveBeenCalledTimes(4)
    expect(first.notes.join(' ')).toContain('pending')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const indexed = collector.get(scene)
    expect(read).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(indexed)).toContain('HaveNoPermission [credential omitted]')
    expect(JSON.stringify(indexed)).not.toContain('secret_12345678901234567890')
    expect(indexed.documents.flatMap(document => document.fields).some(field => field.source.startsWith('Notion blocks'))).toBe(true)
    now += 21_000
    collector.get(scene)
    expect(read.mock.calls.length).toBeGreaterThan(4)
  })
  it('drops unauthorized cached results and never fetches stale-source bodies', async () => {
    const scene = fixtureScene(), read = vi.fn().mockResolvedValue({ outcome: 'available', blocks: [{ text: 'Private prose' }] })
    const collector = new SearchDocumentCollector(read)
    collector.get(scene)
    await Promise.resolve(); await Promise.resolve()
    const retainedId = scene.cards.at(-1)!.id
    scene.cards = scene.cards.filter(card => card.id === retainedId)
    scene.coverage.intentions.status = 'stale'
    const before = read.mock.calls.length
    const result = collector.get(scene)
    expect(read).toHaveBeenCalledTimes(before)
    expect(JSON.stringify(result)).not.toContain('Private prose')
    expect(result.documents.filter(document => document.target.kind === 'card').map(document => document.target.id)).toEqual([retainedId])
  })
})
