// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEffect } from 'react'

// useConstellationGraph PUTs the graph to /api/constellation-graph and, on a failed
// persist, rolls back its optimistic overlay (so reads fall back to server state). In
// jsdom there is no backend, so a real apiFetch would reject and roll back the seeded
// assigns before usePeers observes them. Mock a successful persist so the optimistic
// overlay survives — mirroring production where the PUT succeeds.
vi.mock('../../../apiClient', () => ({
  apiFetch: () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => ({}) } as Response),
  apiUrl: (p: string) => p,
  _resetApiBaseForTests: () => {},
  resetApiBaseFromGlobal: () => {},
}))
import { act, render } from '@testing-library/react'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'
import { ConstellationProvider, useConstellationContext } from '../../../hotkeys/ConstellationContext'
import type { ConstellationSlot } from '../../../domain/constellationGraph'
import { capabilityRegistry } from '../../constellationCapabilities'
import { WidgetIdProvider } from '../widgetIdContext'

function makeRecord(name = 'test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

// Seed nodes into a slot by mounting a child of ConstellationProvider that
// calls ctx.assign() once. localStorage persistence across tests is mitigated
// by using a unique spaceId per test.
function SeedSlot({ slot, ids }: { slot: ConstellationSlot; ids: string[] }) {
  const ctx = useConstellationContext()
  useEffect(() => {
    // Defer assigns to a microtask so the provider's load-on-spaceId-change
    // effect has flushed first — otherwise its `setStore(load(spaceId))`
    // would overwrite our seeds.
    queueMicrotask(() => {
      ids.forEach((id) => ctx.assign(slot, id))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

let testIx = 0
function uniqueSpace(label: string): string {
  testIx += 1
  return `${label}-${testIx}-${Math.random().toString(36).slice(2, 8)}`
}

describe('api.constellations', () => {
  it('Badge renders the slot chip', () => {
    const api = createPluginApi(makeRecord())
    const Badge = api.constellations.Badge
    const { container } = render(<Badge slots={['1', '3', '5']} testId="b" />)
    expect(container.querySelector('[data-testid="b"]')?.textContent).toMatch(/1 3 5/)
  })

  it('Badge renders nothing for empty slots', () => {
    const api = createPluginApi(makeRecord())
    const Badge = api.constellations.Badge
    const { container } = render(<Badge slots={[]} />)
    expect(container.textContent).toBe('')
  })

  it('useContext returns the constellation state when inside a provider', () => {
    const api = createPluginApi(makeRecord())
    let observed: ReturnType<typeof api.constellations.useContext> | null = null
    function Inner() {
      observed = api.constellations.useContext()
      return null
    }
    render(
      <ConstellationProvider spaceId="s-1" nodeIds={['n-1']}>
        <Inner />
      </ConstellationProvider>,
    )
    expect(typeof observed!.slotsForNode).toBe('function')
    expect(typeof observed!.nodesInSlot).toBe('function')
  })
})

describe('api.constellations.usePeers + publishCapability', () => {
  beforeEach(() => {
    capabilityRegistry.clearAll()
    localStorage.clear()
  })

  it('peer appears in usePeers after publishing a capability', async () => {
    const api = createPluginApi(makeRecord())
    let observed: ReturnType<typeof api.constellations.usePeers> = []
    function MyWidget() { observed = api.constellations.usePeers(); return null }
    function PeerWidget() {
      const publish = api.constellations.usePublishCapability()
      useEffect(() => publish('echo', async () => 'ok').dispose, [publish])
      return null
    }
    const spaceId = uniqueSpace('peers-publish')
    await act(async () => {
      render(
        <ConstellationProvider spaceId={spaceId} nodeIds={['editor-mine', 'editor-peer']}>
          <SeedSlot slot={'3'} ids={['editor-mine', 'editor-peer']} />
          <WidgetIdProvider id="editor-mine"><MyWidget /></WidgetIdProvider>
          <WidgetIdProvider id="editor-peer"><PeerWidget /></WidgetIdProvider>
        </ConstellationProvider>,
      )
    })
    // Flush the SeedSlot microtask + the subsequent renders so MyWidget
    // re-observes peers after the seed + capability publish settle.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(observed).toEqual([
      { id: 'editor-peer', kind: 'file-editor', capabilities: ['echo'], snapped: false },
    ])
  })

  it('invokePeerCapability rejects across constellations', async () => {
    const api = createPluginApi(makeRecord())
    let invokeResult: Promise<unknown> | null = null
    let invokeFn: ((peerId: string, name: string, args: unknown) => Promise<unknown>) | null = null
    function MyWidget() {
      invokeFn = api.constellations.useInvokePeerCapability()
      return null
    }
    const spaceId = uniqueSpace('peers-cross')
    await act(async () => {
      render(
        <ConstellationProvider spaceId={spaceId} nodeIds={['editor-mine', 'editor-other']}>
          <SeedSlot slot={'3'} ids={['editor-mine']} />
          <SeedSlot slot={'4'} ids={['editor-other']} />
          <WidgetIdProvider id="editor-mine"><MyWidget /></WidgetIdProvider>
        </ConstellationProvider>,
      )
    })
    // Flush seeds and re-render so invokeFn captures the post-seed ctx.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    invokeResult = invokeFn!('editor-other', 'echo', {})
    await expect(invokeResult).rejects.toThrow(/not in the same constellation/)
  })
})
