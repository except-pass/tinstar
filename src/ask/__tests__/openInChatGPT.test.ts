import { describe, expect, it } from 'vitest'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { readOverviewSearch } from '../../cockpit/overviewQuery'
import type { PullDetail, PullSummary } from '../../shared/pulls'
import { MAX_CHATGPT_PROMPT, MAX_CHATGPT_URL, openInChatGPT } from '../openInChatGPT'

const at = '2026-11-09T16:00:00.000Z'
const pull: PullSummary = { id: 'except-pass/tinstar#123', repository: 'except-pass/tinstar', number: 123, url: 'https://github.com/except-pass/tinstar/pull/123?token=do-not-copy#fragment', title: 'A useful PR', author: 'owner', draft: false, head: 'a'.repeat(40), base: 'main', createdAt: at, updatedAt: at, observedAt: at, freshness: 'fresh', links: [{ cardId: fixtureId(1), active: true, sources: ['card-property'], events: [] }] }
const detail: PullDetail = { head: pull.head, state: 'open', body: 'Customer data must never be copied', bodyTruncated: false, additions: 1, deletions: 0, files: 1, checks: 'failed', reviews: [], review: 'Unknown', reviewsComplete: false, observedAt: at, freshness: 'fresh', error: null }
const prTarget = () => ({ kind: 'pull' as const, pull, detail, now: Date.parse(at), associationsComplete: true })
const workTarget = () => { const scene = fixtureScene(); return { kind: 'work' as const, card: scene.cards[0]!, scene } }
const base = 'https://tinstar.example/app/?worker=old&token=do-not-copy#private'

describe('Open in ChatGPT launch packages', () => {
  it('encodes a neutral work discussion with canonical card and source links', () => {
    const target = workTarget()
    target.card.source.properties.Name!.value = 'Discuss A&B? 日本語 #1'
    const result = openInChatGPT(target, 'discuss', base), url = new URL(result.url)
    expect(url.origin + url.pathname).toBe('https://chatgpt.com/')
    expect(url.searchParams.get('prompt')).toBe(result.prompt)
    expect([...url.searchParams.keys()]).toEqual(['prompt'])
    expect(result.prompt).toContain("Let's discuss this work item.")
    expect(result.prompt).toContain(`Work ID: ${target.card.id}`)
    expect(result.prompt).toContain(`Notion: https://www.notion.so/${target.card.id}`)
    expect(result.prompt).toContain(`Tin Star: https://tinstar.example/app/?card=${target.card.id}`)
    expect(result.prompt).toContain('Discuss A&B? 日本語 #1')
    expect(result.prompt).not.toMatch(/do-not-copy|worker=|#private/)
  })
  it('uses canonical PR identity, a working Tin Star locator, observed CI and active work only', () => {
    const result = openInChatGPT(prTarget(), 'discuss', base)
    expect(result.prompt).toContain('PR ID: except-pass/tinstar#123')
    expect(result.prompt).toContain('GitHub: https://github.com/except-pass/tinstar/pull/123\n')
    expect(result.prompt).toContain(`CI: failed (observed); observed ${at}`)
    expect(result.prompt).toContain(`Linked work (source association): ${fixtureId(1)}`)
    const line = result.prompt.split('\n').find(line => line.startsWith('Tin Star: '))!
    const locator = readOverviewSearch(new URL(line.slice(10)).search)
    expect(locator.page).toBe('pulls')
    expect(locator.origin?.target).toEqual({ kind: 'pull', id: pull.id })
    expect(result.prompt).not.toMatch(/Customer|do-not-copy|bodyTruncated/)
  })
  it('distinguishes stale CI, unknown CI at another head and partial associations', () => {
    const target = { ...prTarget(), associationsComplete: false, now: Date.parse(at) + 120_001 }
    expect(openInChatGPT(target).prompt).toContain('failed (last known / stale)')
    expect(openInChatGPT(target).prompt).toContain('Partial / last known; absence is unknown')
    expect(openInChatGPT({ ...target, detail: { ...detail, head: 'b'.repeat(40) } }).prompt).toContain('CI: Unknown (not read for this head)')
    expect(openInChatGPT({ ...target, readFailed: true }).prompt).toContain('PR read: last known / read failed')
  })
  it('labels empty/unknown metadata and never manufactures malformed identifiers', () => {
    const target = workTarget()
    target.card.id = 'invalid?token=secret'; target.card.source.properties = {}
    target.scene.coverage.intentions.observedAt = null
    const result = openInChatGPT(target)
    expect(result.prompt).toContain('Work ID: Unknown (invalid source identifier)')
    expect(result.prompt).toContain('observed Unknown')
    expect(result.prompt).toContain('Owner: Unknown')
    expect(result.prompt).not.toMatch(/invalid\?|notion\.so|Tin Star:/)
    for (const malformed of ['javascript:alert(1)', 'https://evil.test/o/r/pull/1', 'https://github.com/o/r/pull/9007199254740992']) {
      const result = openInChatGPT({ ...prTarget(), pull: { ...pull, url: malformed } })
      expect(result.prompt).toContain('PR ID: Unknown')
      expect(result.prompt).not.toMatch(/GitHub:|Tin Star:/)
    }
    expect(openInChatGPT({ ...prTarget(), pull: { ...pull, number: 42 } }).prompt).toContain('inconsistent source identifier')
  })
  it('omits bodies, logs, extra properties, contact data, recognizable credentials and URL credentials', () => {
    const target = workTarget()
    target.card.source.properties.Name!.value = 'Discuss sk-testSecret123 token=rawToken Bearer abc123 https://foo.test/?token=abc owner@example.com'
    target.card.source.properties['Customer'] = { id: null, type: 'rich_text', value: 'private customer payload', hasMore: false }
    target.card.source.url = 'https://token:secret@notion.so/private?token=secret'
    const result = openInChatGPT(target, 'discuss', 'https://user:password@tinstar.example/?token=secret')
    expect(result.prompt).toContain('[redacted]')
    expect(result.prompt).not.toMatch(/testSecret123|rawToken|abc123|private customer|owner@example|password|token=|token:secret/)
  })
  it('bounds text and encoded URL size even for large multibyte metadata, deterministically', () => {
    const target = workTarget()
    for (const name of ['Name', 'Owner', 'Initiative', 'Epic', 'Status']) target.card.source.properties[name] = { id: null, type: 'rich_text', value: '🛰️日本語'.repeat(5000), hasMore: false }
    const result = openInChatGPT(target, 'discuss', base)
    expect(result.prompt.length).toBeLessThanOrEqual(MAX_CHATGPT_PROMPT)
    expect(result.url.length).toBeLessThanOrEqual(MAX_CHATGPT_URL)
    expect(new URL(result.url).searchParams.get('prompt')).toBe(result.prompt)
    expect(result).toEqual(openInChatGPT(target, 'discuss', base))
    expect(result.prompt).toContain(target.card.id)
  })
  it('handles damaged Unicode metadata and skips unsafe app URL schemes', () => {
    const target = workTarget()
    target.card.source.properties.Name!.value = 'Damaged \ud800 title'
    const result = openInChatGPT(target, 'discuss', 'javascript:alert(1)')
    expect(result.prompt).toContain('Damaged \ufffd title')
    expect(result.prompt).not.toContain('Tin Star:')
    expect(new URL(result.url).searchParams.get('prompt')).toBe(result.prompt)
  })
})
