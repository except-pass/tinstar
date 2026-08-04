import { describe, expect, it } from 'vitest'
import { natsBrokerUrl } from '../url'

describe('natsBrokerUrl', () => {
  it('keeps the host and managed MCP clients on the same configured broker', () => {
    expect(natsBrokerUrl({})).toBe('nats://127.0.0.1:4222')
    expect(natsBrokerUrl({ NATS_PORT: '4666' })).toBe('nats://127.0.0.1:4666')
    expect(natsBrokerUrl({
      NATS_PORT: '4666',
      NATS_URL: 'nats://shared.example:4222',
    })).toBe('nats://shared.example:4222')
  })
})
