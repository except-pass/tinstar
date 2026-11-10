import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { SceneSessions } from '../../server/reconciliation/sessions'
import { fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { usePresentation } from '../usePresentation'
import { actionSchema, stateSchema } from '../../shared/reconciliationCommands'
import { deliverySchema, renderedObservationSchema, presentationTargets } from '../../shared/presentationObservation'
import { observeTargets, revealTargets } from '../presentationVisibility'

const scene = fixtureScene(), queue = fixtureQueue(), cardId = queue.items[0]!.cardIds[0]!
let broker: SceneSessions, hidden = false, focused = true
let latest: ReturnType<typeof usePresentation>
function Browser({ source = scene }: { source?: typeof scene }) {
  const [surface, setSurface] = useState('overview')
  latest = usePresentation(source, queue, false, true, surface === 'decisions', false, () => setSurface('decisions'))
  return <div className={surface === 'decisions' ? 'decisions' : 'ov'} data-revision={latest.state.revision}>
    <button className={`decisions-row${latest.state.selection?.id === cardId ? ' selected' : ''}${latest.state.flash && latest.state.flash.until > Date.now() ? ' flashed' : ''}`} data-card-id={cardId} data-semantic-id={`card:${cardId}`}>Target decision</button>
    <button onClick={() => latest.send({ type: 'clear-selection' })}>Browse manually</button>
  </div>
}
async function tick(ms = 1050) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function enqueue(command_id = 'target') {
  const tab = broker.list()[0]!
  const input = { scene_id: tab.scene_id, command_id, expected_revision: tab.revision, ttl_ms: 8000, action: { type: 'navigate-card' as const, cardId } }
  expect(broker.enqueue(input, scene).outcome).toBe('queued')
  return input
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); hidden = false; focused = true; broker = new SceneSessions()
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible')
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [{ width: 300, height: 40 }] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 10, y: 10, left: 10, top: 10, right: 310, bottom: 50, width: 300, height: 40, toJSON() {} }))
  vi.stubGlobal('fetch', vi.fn(async (_url, request) => {
    const body = JSON.parse(request.body)
    const data = body.type === 'register' ? broker.register(body.state, body.rendered_scene)
      : body.type === 'sync' ? { commands: broker.sync(body.scene_id, body.state, body.acknowledgments, body.rendered_scene), designated: broker.read(body.scene_id).designated }
      : body.type === 'designate' ? (broker.designate(body.scene_id), { designated: true }) : {}
    return new Response(JSON.stringify({ ok: true, data }))
  }))
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('[data-card-id]') })
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('browser delivery and replay', () => {
  it('routes assistant navigation through the workspace and observes the actual DOM target before visible delivery', async () => {
    render(<Browser />); await tick()
    // The committed-state acknowledgment precedes the DOM observation in sync.
    const input = enqueue(); await tick(); await tick(); await tick()
    expect(document.querySelector('.decisions .selected')).toBe(screen.getByText('Target decision'))
    expect(broker.result(input.scene_id, input.command_id)).toMatchObject({ outcome: 'applied', delivery: { stage: 'foreground-visible', surface: 'decisions', targets: [`card:${cardId}`], visible_targets: [`card:${cardId}`], pending: false } })
    const observation = broker.read(input.scene_id).rendered_scene!
    expect(observation.rendered_at).toBeTruthy()
    expect(observation.scene_generated_at).toBe(scene.generatedAt)
    expect(observation.surface).toBe('decisions')
    await act(async () => latest.useThisTab())
    expect(broker.resolve()).toEqual({ scene_id: input.scene_id })
    expect(broker.list()[0]!.designated).toBe(true)
  })
  it('retains background focus past flash expiry, then replays on foreground without another revision or command', async () => {
    hidden = true; focused = false
    render(<Browser />); await tick()
    const input = enqueue(); await tick(); await tick(5500)
    expect(broker.result(input.scene_id, input.command_id)).toMatchObject({ outcome: 'applied', delivery: { stage: 'not-visible', visible_targets: [], pending: true } })
    expect(latest.pendingFocus).toBe(true)
    expect(latest.state.flash!.until).toBeLessThan(Date.now())
    const revision = latest.state.revision
    hidden = false; focused = true
    act(() => window.dispatchEvent(new Event('focus')))
    // Drain the earlier not-visible acknowledgment before the replay observation.
    await tick(); await tick()
    expect(latest.state.flash!.until).toBeGreaterThan(Date.now())
    expect(latest.state.revision).toBe(revision)
    expect(latest.pendingFocus).toBe(false)
    expect(broker.enqueue(input, scene)).toMatchObject({ outcome: 'applied', delivery: { stage: 'foreground-visible', pending: false } })
    expect(broker.sync(input.scene_id, latest.state, [])).toEqual([])
  })
  it('replays all 4097 reveal targets and serializes the foreground state at the original revision', async () => {
    hidden = true; focused = false
    const source = fixtureScene(), template = source.cards[0]!
    source.cards = Array.from({ length: 4097 }, (_, index) => ({ ...template, id: index === 0 ? 'primary'.padEnd(2048, 'x') : index.toString(16).padStart(32, '0') }))
    render(<Browser source={source} />); await tick()
    const tab = broker.list()[0]!, target = { kind: 'card' as const, id: source.cards[0]!.id }
    const action = { type: 'reveal-search' as const, target, targets: source.cards.slice(1).map(card => ({ kind: 'card' as const, id: card.id })) }
    expect(broker.enqueue({ scene_id: tab.scene_id, command_id: 'large-replay', expected_revision: tab.revision, ttl_ms: 8000, action }, source).outcome).toBe('queued')
    await tick(); await tick(5500)
    const ids = presentationTargets(action).map(target => `${target.kind}:${target.id}`)
    expect(latest.state.searchFocus).toEqual(presentationTargets(action))
    expect(latest.pendingFocus).toBe(true)
    const revision = latest.state.revision
    hidden = false; focused = true
    act(() => window.dispatchEvent(new Event('focus')))
    await tick()
    expect(latest.state.flash?.ids).toEqual(ids)
    expect(latest.state.revision).toBe(revision)
    expect(stateSchema.parse(JSON.parse(JSON.stringify(latest.state))).flash?.ids).toEqual(ids)
    expect(renderedObservationSchema.parse(broker.read(tab.scene_id).rendered_scene).selection).toBe(ids[0])
    expect(broker.read(tab.scene_id).state?.flash?.ids).toEqual(ids)
  })
  it.each(['reveal-search', 'flash'] as const)('keeps card delivery pending for a mixed card and claim %s through background replay', async type => {
    hidden = true; focused = false
    render(<Browser />); await tick()
    const tab = broker.list()[0]!, card = { kind: 'card' as const, id: cardId }, claim = { kind: 'claim' as const, id: scene.claims[0]!.id }
    const action = type === 'reveal-search' ? { type, target: card, targets: [claim] } : { type, targets: [card, claim] }
    expect(broker.enqueue({ scene_id: tab.scene_id, command_id: 'mixed', expected_revision: tab.revision, ttl_ms: 8000, action }, scene).outcome).toBe('queued')
    await tick(); await tick(5500)
    expect(broker.result(tab.scene_id, 'mixed').delivery).toMatchObject({ stage: 'not-visible', pending: true })
    expect(latest.pendingFocus).toBe(true)
    expect(latest.state.flash!.until).toBeLessThan(Date.now())
    const revision = latest.state.revision
    hidden = false; focused = true
    act(() => window.dispatchEvent(new Event('focus')))
    await tick(); await tick()
    expect(latest.state.revision).toBe(revision)
    expect(latest.state.flash!.until).toBeGreaterThan(Date.now())
    expect(latest.state.flash!.ids).toEqual([`card:${cardId}`, `claim:${claim.id}`])
    expect(broker.result(tab.scene_id, 'mixed').delivery).toMatchObject({ stage: 'not-supported', targets: [`card:${cardId}`, `claim:${claim.id}`], visible_targets: [`card:${cardId}`], pending: false })
    expect(latest.pendingFocus).toBe(false)
  })
  it('coalesces failed background delivery polls so the next short-lived command is acknowledged promptly', async () => {
    hidden = true; focused = false
    const transport = vi.mocked(fetch).getMockImplementation()!
    let failures = 0
    const sent: Array<{ command_id: string; applied_at?: number; delivery?: { pending?: boolean; reason?: string } }> = []
    vi.stubGlobal('fetch', vi.fn(async (url, request) => {
      const payload = JSON.parse(String(request!.body))
      if (payload.type === 'sync') {
        expect(payload.acknowledgments.length).toBeLessThanOrEqual(1)
        sent.push(...payload.acknowledgments)
        if (failures > 0) { failures--; throw new Error('Temporary sync failure') }
      }
      return transport(url, request)
    }))
    render(<Browser />); await tick()
    const first = enqueue('background'); await tick(); await tick()
    const firstCommit = broker.result(first.scene_id, first.command_id).applied_at
    expect(firstCommit).toBeDefined()
    failures = 30
    await tick(30_000)
    expect(failures).toBe(0)
    expect(latest.bridgeError).toBe(true)
    await tick()
    expect(latest.bridgeError).toBe(false)
    const second = { scene_id: first.scene_id, command_id: 'short-lived', expected_revision: latest.state.revision, ttl_ms: 1500, action: { type: 'navigate-card' as const, cardId } }
    expect(broker.enqueue(second, scene).outcome).toBe('queued')
    await tick()
    expect(latest.state.revision).toBe(second.expected_revision + 1)
    await tick(); await tick()
    const result = broker.result(second.scene_id, second.command_id)
    expect(result).toMatchObject({ outcome: 'applied', revision: second.expected_revision + 1 })
    expect(result.applied_at).toBe(sent.find(ack => ack.command_id === second.command_id)!.applied_at)
    expect(broker.result(first.scene_id, first.command_id)).toMatchObject({ applied_at: firstCommit, delivery: { pending: false, reason: 'Superseded by a newer assistant command.' } })
  })
  it.each(['manual', 'foreground'] as const)('keeps the newer %s terminal observation when an older in-flight batch fails', async finish => {
    hidden = true; focused = false
    render(<Browser />); await tick()
    const input = enqueue('in-flight'); await tick(); await tick()
    const appliedAt = broker.result(input.scene_id, input.command_id).applied_at
    const transport = vi.mocked(fetch).getMockImplementation()!
    let rejectRequest!: (error: Error) => void, holding = true
    vi.stubGlobal('fetch', vi.fn(async (url, request) => {
      const payload = JSON.parse(String(request!.body))
      if (payload.type === 'sync' && holding) {
        holding = false
        return new Promise<Response>((_resolve, reject) => { rejectRequest = reject })
      }
      return transport(url, request)
    }))
    await tick()
    expect(rejectRequest).toBeDefined()
    if (finish === 'manual') fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    else {
      hidden = false; focused = true
      act(() => window.dispatchEvent(new Event('focus')))
      act(() => window.dispatchEvent(new Event('focus')))
    }
    await act(async () => { rejectRequest(new Error('Lost response')); await Promise.resolve() })
    await tick()
    const receipt = broker.result(input.scene_id, input.command_id)
    expect(receipt.applied_at).toBe(appliedAt)
    expect(receipt.delivery).toMatchObject({ stage: finish === 'manual' ? 'not-visible' : 'foreground-visible', pending: false })
    if (finish === 'manual') expect(receipt.delivery?.reason).toBe('Superseded by user interaction.')
  })
  it('lets manual interaction cancel background replay', async () => {
    hidden = true; focused = false
    render(<Browser />); await tick()
    const input = enqueue(); await tick(); await tick(5500)
    fireEvent.click(screen.getByText('Browse manually')); await tick()
    hidden = false; focused = true
    act(() => window.dispatchEvent(new Event('focus'))); await tick()
    expect(latest.state.selection).toBeNull()
    expect(latest.state.flash!.until).toBeLessThan(Date.now())
    expect(broker.result(input.scene_id, input.command_id).delivery).toMatchObject({ stage: 'not-visible', pending: false, reason: 'Superseded by user interaction.' })
  })
  it('observes and focuses an open card Inspector when it covers the same board row', () => {
    render(<div className="ov"><button data-semantic-id={`card:${cardId}`}>Board row</button><section className="ov-inspector" data-semantic-id={`card:${cardId}`} tabIndex={-1}>Card detail</section></div>)
    const inspector = screen.getByText('Card detail')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => inspector })
    revealTargets([`card:${cardId}`], 'overview')
    expect(inspector).toHaveFocus()
    expect(observeTargets([`card:${cardId}`], 'overview')).toMatchObject({ stage: 'foreground-visible', visible_targets: [`card:${cardId}`], pending: false })
  })
  it('distinguishes covered DOM targets and unsupported surfaces from foreground visibility', () => {
    render(<div className="ov"><button data-semantic-id={`card:${cardId}`}>Target</button><aside>Cover</aside></div>)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('aside') })
    expect(observeTargets([`card:${cardId}`], 'overview')).toMatchObject({ stage: 'rendered', rendered_targets: [`card:${cardId}`], visible_targets: [], pending: true })
    expect(observeTargets(['you:root'], 'overview')).toMatchObject({ stage: 'not-supported', pending: false })
  })
})

it('serializes every accepted reveal target and deduplicates semantic identities', () => {
  const target = { kind: 'card' as const, id: 'primary' }
  const targets = Array.from({ length: 4096 }, (_, i) => ({ kind: 'execution' as const, id: String(i).padEnd(2048, 'x') }))
  const action = { type: 'reveal-search' as const, target, targets }
  expect(actionSchema.safeParse(action).success).toBe(true)
  const ids = presentationTargets(action).map(target => `${target.kind}:${target.id}`)
  expect(ids).toHaveLength(4097)
  expect(deliverySchema.safeParse({ stage: 'foreground-visible', targets: ids, rendered_targets: ids, visible_targets: ids }).success).toBe(true)
  expect(presentationTargets({ ...action, targets: [target, targets[0]!, target, targets[0]!] })).toEqual([target, targets[0]])
})
