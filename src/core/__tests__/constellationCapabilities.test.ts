import { describe, it, expect, beforeEach } from 'vitest'
import { capabilityRegistry } from '../constellationCapabilities'

describe('capabilityRegistry', () => {
  beforeEach(() => capabilityRegistry.clearAll())

  it('publish + capabilitiesOf returns the capability name', () => {
    capabilityRegistry.publish('w1', 'session.prompt', async () => 'ok')
    expect(capabilityRegistry.capabilitiesOf('w1')).toEqual(['session.prompt'])
  })

  it('dispose removes the capability', () => {
    const dispose = capabilityRegistry.publish('w1', 'session.prompt', async () => 'ok')
    dispose()
    expect(capabilityRegistry.capabilitiesOf('w1')).toEqual([])
  })

  it('invoke calls the handler and returns its result', async () => {
    capabilityRegistry.publish('w1', 'echo', async (args) => ({ got: args }))
    const result = await capabilityRegistry.invoke('w1', 'echo', { text: 'hi' })
    expect(result).toEqual({ got: { text: 'hi' } })
  })

  it('invoke rejects when capability not published', async () => {
    await expect(capabilityRegistry.invoke('w1', 'missing', {}))
      .rejects.toThrow(/not published/)
  })

  it('notifies subscribers when capabilities change', () => {
    const events: string[] = []
    const unsub = capabilityRegistry.subscribe(() => events.push('changed'))
    capabilityRegistry.publish('w1', 'a', async () => null)
    capabilityRegistry.publish('w2', 'b', async () => null)
    unsub()
    capabilityRegistry.publish('w3', 'c', async () => null)
    expect(events.length).toBe(2)
  })
})
