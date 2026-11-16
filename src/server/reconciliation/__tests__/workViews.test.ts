import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReconciliationSources } from '../index'
import { CardContextReader } from '../cardContext'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'

afterEach(() => vi.restoreAllMocks())

it('returns the full fresh census with bounded history while shared operational recovery is blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-views-'))
  const snapshot = fixtureSources({ now: Date.now() })
  const template = snapshot.intentions.data!.cards[0]!
  snapshot.intentions.data!.cards = Array.from({ length: 92 }, (_, index) => {
    const card = structuredClone(template)
    card.id = (index + 1).toString(16).padStart(32, '0')
    card.properties.Owner!.value = 'Will'
    card.properties.Status!.value = index < 78 ? 'In Progress' : 'Ready for Review'
    card.properties['Will action'] = { id: 'action', type: 'multi_select', value: index < 78 ? ['Decision'] : [], hasMore: false }
    card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Choose an option', hasMore: false }
    return card
  })
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, root)
  const read = vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  const recovery = vi.spyOn(sources.workflow, 'reconcileReviews').mockImplementation(() => new Promise(() => {}))
  const handoffs = sources.reconcileReviewHandoffs = vi.fn(async () => {})
  const history = vi.spyOn(CardContextReader.prototype, 'commentDetails').mockResolvedValue({ outcome: 'available', blocks: [] })
  try {
    const first = await sources.workViews()
    expect(read).toHaveBeenCalledWith(true)
    expect(first.needsWill).toHaveLength(78)
    expect(first.reviews.items).toHaveLength(14)
    expect(first.reviews.complete).toBe(true)
    expect(first.coverage.intentions).toMatchObject({ status: 'fresh', coverage: 'complete' })
    expect(history).toHaveBeenCalledTimes(20)
    expect(history.mock.calls.every(([, force]) => force === false)).toBe(true)
    expect(first.warnings).toContainEqual(expect.stringContaining('20 of 78'))
    expect(first.warnings).toContainEqual(expect.stringContaining('reconciliation and uncached review submission history refresh in the background'))
    expect(first.reviews.items.every(item => !!item.evidenceWarning)).toBe(true)
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1))
    expect(handoffs).not.toHaveBeenCalled()
    // A second tool call must not wait for or duplicate the stuck refresh.
    const second = await sources.workViews()
    expect(second.needsWill).toHaveLength(78)
    expect(second.reviews.items).toHaveLength(14)
    expect(recovery).toHaveBeenCalledTimes(1)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 2000)
