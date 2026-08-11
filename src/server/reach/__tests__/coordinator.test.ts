import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReachCoordinator } from '../coordinator'
import type { ReachProvider, ReachProviderMapping } from '../provider'
import { readReachMapping, readReachPreference, writeReachMapping } from '../state'
import {
  currentOriginAllowlist,
  resetOriginAllowlistForTests,
} from '../../api/originAllowlist'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-reach-co-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  resetOriginAllowlistForTests()
})

/** A provider whose whole world is one list of mappings. */
function fakeProvider(initial: ReachProviderMapping[] = []) {
  const mappings = [...initial]
  const calls = { establish: [] as number[], revoke: [] as number[], listed: 0 }
  const provider: ReachProvider = {
    name: 'fake',
    async currentMappings() { calls.listed += 1; return [...mappings] },
    async establish({ port }) {
      calls.establish.push(port)
      const mapping = { port, url: `https://fake.example/${port}` }
      mappings.push(mapping)
      return mapping
    },
    async revoke(mapping) {
      calls.revoke.push(mapping.port)
      const i = mappings.findIndex(m => m.port === mapping.port)
      if (i >= 0) mappings.splice(i, 1)
    },
  }
  return { provider, calls, mappings }
}

function coordinator(
  provider: ReachProvider,
  opts: { disabled?: boolean } = {},
) {
  return new ReachCoordinator({
    configRoot: root,
    provider,
    disabled: opts.disabled ?? false,
    now: () => '2026-08-06T00:00:00.000Z',
  })
}

describe('ReachCoordinator — lifecycle', () => {
  it('reports inactive and writes nothing when freshly constructed', async () => {
    const { provider, calls } = fakeProvider()
    const reach = coordinator(provider)

    expect((await reach.status()).state).toBe('off')
    expect(readReachPreference(root)).toBeNull()
    expect(readReachMapping(root)).toBeNull()
    expect(calls.establish).toEqual([])
  })

  it('never touches the provider when reach is disabled at startup', async () => {
    // R24: a second backend on the same host must be usable, not blocked.
    const { provider, calls } = fakeProvider()
    const reach = coordinator(provider, { disabled: true })

    await reach.onListening(5273)
    const result = await reach.enable(5273)

    expect(result.state).toBe('refused')
    expect(result.detail).toMatch(/disabled/i)
    expect(calls).toEqual({ establish: [], revoke: [], listed: 0 })
  })

  it('establishes on the port the listener actually bound', async () => {
    // The listener falls back to a higher port when the configured one is busy.
    // Fronting the configured port would leave the remote URL pointing at
    // nothing while localhost worked fine.
    const { provider, calls } = fakeProvider()
    const reach = coordinator(provider)

    const result = await reach.enable(5281)

    expect(result.state).toBe('active')
    expect(calls.establish).toEqual([5281])
    expect(readReachMapping(root)?.port).toBe(5281)
  })

  it('leaves no state claiming an active mapping after revoke', async () => {
    const { provider, calls } = fakeProvider()
    const reach = coordinator(provider)

    await reach.enable(5273)
    await reach.disable()

    expect(calls.revoke).toEqual([5273])
    expect(readReachMapping(root)).toBeNull()
    expect((await reach.status()).state).toBe('off')
  })
})

describe('ReachCoordinator — the opt-in outlives the mapping', () => {
  it('clears the mapping on clean shutdown but preserves the preference', async () => {
    const { provider, calls } = fakeProvider()
    const reach = coordinator(provider)
    await reach.enable(5273)

    await reach.shutdown()

    expect(calls.revoke).toEqual([5273])
    expect(readReachMapping(root)).toBeNull()
    expect(readReachPreference(root)?.enabled).toBe(true)
  })

  it('re-establishes on the next start after a clean shutdown', async () => {
    const first = fakeProvider()
    const reach = coordinator(first.provider)
    await reach.enable(5273)
    await reach.shutdown()

    const second = fakeProvider()
    const restarted = coordinator(second.provider)
    await restarted.onListening(5273)

    expect(second.calls.establish).toEqual([5273])
    expect((await restarted.status()).state).toBe('active')
  })

  it('does not re-establish after the operator turns reach off', async () => {
    const first = fakeProvider()
    const reach = coordinator(first.provider)
    await reach.enable(5273)
    await reach.disable()

    const second = fakeProvider()
    const restarted = coordinator(second.provider)
    await restarted.onListening(5273)

    expect(second.calls.establish).toEqual([])
    expect((await restarted.status()).state).toBe('off')
  })

  it('does nothing on shutdown when no mapping is active', async () => {
    const { provider, calls } = fakeProvider()
    const reach = coordinator(provider)

    await reach.shutdown()

    expect(calls.revoke).toEqual([])
  })
})

describe('ReachCoordinator — one holder per host', () => {
  it('refuses establish when the provider already serves someone else, naming it', async () => {
    const { provider, calls } = fakeProvider([
      { port: 5273, url: 'https://held.example/5273' },
    ])
    const reach = coordinator(provider)

    const result = await reach.enable(5281)

    expect(result.state).toBe('refused')
    expect(result.detail).toContain('https://held.example/5273')
    expect(calls.establish).toEqual([])
  })

  it('never revokes a mapping it does not own', async () => {
    const held = { port: 5273, url: 'https://held.example/5273' }
    const { provider, calls, mappings } = fakeProvider([held])
    const reach = coordinator(provider)

    await reach.shutdown()
    await reach.disable()

    expect(calls.revoke).toEqual([])
    expect(mappings).toEqual([held])
  })

  it('adopts its own recorded mapping across a restart rather than stacking a duplicate', async () => {
    const first = fakeProvider()
    const reach = coordinator(first.provider)
    await reach.enable(5273)

    // Same config root, same provider state, new process: the mapping already
    // there is ours, so reconcile must confirm it rather than refuse or add.
    const restarted = new ReachCoordinator({
      configRoot: root,
      provider: first.provider,
      disabled: false,
      now: () => '2026-08-06T00:00:00.000Z',
    })
    await restarted.onListening(5273)

    expect(first.calls.establish).toEqual([5273])
    expect(first.mappings).toHaveLength(1)
    expect((await restarted.status()).state).toBe('active')
  })

  it('refuses rather than claiming off when it has no authority to revoke', async () => {
    // A --no-reach instance took the early return and answered a confident 'off'
    // while doing nothing. The CLI reads 'off' as "confirmed down" and deletes the
    // HOST-GLOBAL sudoers grant — so a second backend that legitimately holds a
    // mapping loses the privilege it needs, on the word of an instance that never
    // looked. 'off' has to mean "I checked", not "I did not participate".
    const p = fakeProvider()
    const reach = new ReachCoordinator({
      configRoot: root,
      provider: p.provider,
      disabled: true,
      now: () => '2026-08-06T00:00:00.000Z',
    })
    const status = await reach.disable()
    expect(status.state).toBe('refused')
    expect(status.detail ?? '').toMatch(/disabled/i)
  })

  it('refuses rather than claiming off when the live mapping is not ours', async () => {
    // Same hazard from the other direction: another instance's mapping is
    // recorded, we revoke nothing, and answering 'off' spends a grant that is
    // not ours to spend.
    const p = fakeProvider()
    const reach = coordinator(p.provider)
    await reach.enable(5273)
    // Rewrite the record so it belongs to a different instance.
    const mapping = readReachMapping(root)!
    writeReachMapping(root, { ...mapping, instanceId: 'some-other-instance' })

    const status = await reach.disable()
    expect(status.state).toBe('refused')
    expect(p.calls.revoke).toEqual([])
  })

  it('reports stranded, not off, when the revoke fails', async () => {
    // The failure this exists for: a revoke that does not land, reported as a
    // clean 'off'. The CLI believed it and deleted the privilege grant, which
    // removed the only way to finish taking the mapping down.
    const p = fakeProvider()
    const reach = coordinator(p.provider)
    await reach.enable(5273)
    const url = (await reach.status()).url!

    p.provider.revoke = async () => { throw new Error('tailscaled is not running') }
    const status = await reach.disable()

    expect(status.state).toBe('stranded')
    expect(status.url).toBe(url)
    expect(status.detail ?? '').toMatch(/tailscaled is not running/)
    // The record MUST survive: it is how doctor finds the stranded mapping and
    // how a later retry knows which URL to take down.
    expect(readReachMapping(root)).not.toBeNull()
    // The preference is off regardless — the operator's wish is not in doubt,
    // only whether the provider acted on it.
    expect(readReachPreference(root)?.enabled).toBe(false)
  })

  it('reports stranded from status() too, so a restart still surfaces it', async () => {
    const p = fakeProvider()
    const reach = coordinator(p.provider)
    await reach.enable(5273)
    p.provider.revoke = async () => { throw new Error('nope') }
    await reach.disable()

    // A fresh process reading the same files must reach the same conclusion:
    // preference off, our mapping still recorded, so this host may still be up.
    const restarted = coordinator(p.provider)
    expect((await restarted.status()).state).toBe('stranded')
  })

  it('returns to a clean off when a later revoke succeeds', async () => {
    const p = fakeProvider()
    const reach = coordinator(p.provider)
    await reach.enable(5273)
    const failing = async () => { throw new Error('down') }
    const working = p.provider.revoke
    p.provider.revoke = failing
    expect((await reach.disable()).state).toBe('stranded')

    p.provider.revoke = working
    const second = await reach.disable()
    expect(second.state).toBe('off')
    expect(readReachMapping(root)).toBeNull()
  })

  it('re-registers the reach origin when it adopts a mapping across a restart', async () => {
    const first = fakeProvider()
    const reach = coordinator(first.provider)
    await reach.enable(5273)
    const url = (await reach.status()).url!

    // A restart keeps the on-disk mapping but NOT the in-memory origin set, so
    // the new process must re-register from what it reconciled. Without this the
    // canvas loads over the tailnet and every terminal upgrade is refused, which
    // is the shape of the bug the previous review already caught once.
    resetOriginAllowlistForTests()
    expect(currentOriginAllowlist()).not.toContain(url)

    const restarted = new ReachCoordinator({
      configRoot: root,
      provider: first.provider,
      disabled: false,
      now: () => '2026-08-06T00:00:00.000Z',
    })
    await restarted.onListening(5273)

    expect((await restarted.status()).state).toBe('active')
    expect(currentOriginAllowlist()).toContain(url)
  })

  it('repairs its own mapping when the bound port moved', async () => {
    const first = fakeProvider()
    const reach = coordinator(first.provider)
    await reach.enable(5273)

    const restarted = coordinator(first.provider)
    await restarted.onListening(5274)

    expect(first.calls.revoke).toEqual([5273])
    expect(first.calls.establish).toEqual([5273, 5274])
    expect(first.mappings).toEqual([{ port: 5274, url: 'https://fake.example/5274' }])
    expect(readReachMapping(root)?.port).toBe(5274)
  })

  it('surfaces a provider failure as refused rather than throwing at boot', async () => {
    const { provider } = fakeProvider()
    const failing: ReachProvider = {
      ...provider,
      establish: vi.fn(async () => { throw new Error('tailscaled not running') }),
    }
    const reach = coordinator(failing)

    const result = await reach.enable(5273)

    expect(result.state).toBe('refused')
    expect(result.detail).toContain('tailscaled not running')
    expect(readReachMapping(root)).toBeNull()
  })
})

describe('ReachCoordinator — the reach origin is allowed for exactly its lifetime', () => {
  it('registers the origin on establish', async () => {
    const { provider } = fakeProvider()
    const reach = coordinator(provider)

    await reach.enable(5273)

    expect(currentOriginAllowlist()).toContain('https://fake.example/5273')
  })

  it('unregisters it on revoke', async () => {
    const { provider } = fakeProvider()
    const reach = coordinator(provider)
    await reach.enable(5273)

    await reach.disable()

    expect(currentOriginAllowlist()).not.toContain('https://fake.example/5273')
  })

  it('unregisters it on a clean shutdown too', async () => {
    const { provider } = fakeProvider()
    const reach = coordinator(provider)
    await reach.enable(5273)

    await reach.shutdown()

    expect(currentOriginAllowlist()).not.toContain('https://fake.example/5273')
  })
})
