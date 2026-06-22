import { describe, it, expect } from 'vitest'
import { brokerConnection } from '../nats-traffic'

describe('brokerConnection', () => {
  it('down when there is no connection', () => {
    expect(brokerConnection(null)).toBe('down')
  })
  it('up when the connection is open', () => {
    expect(brokerConnection({ isClosed: () => false })).toBe('up')
  })
  it('down when the connection is closed', () => {
    expect(brokerConnection({ isClosed: () => true })).toBe('down')
  })
})
