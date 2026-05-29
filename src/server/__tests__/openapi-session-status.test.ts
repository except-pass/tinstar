import { describe, it, expect } from 'vitest'
import { spec } from '../api/openapi'
import type { SessionStatus } from '../../types'

describe('openapi Session.state enum', () => {
  it('matches every variant of SessionStatus', () => {
    const allStatuses: SessionStatus[] = ['creating', 'running', 'idle', 'needs_attention', 'stopped']
    const session = (spec as unknown as { components: { schemas: { Session: { properties: { state: { enum: string[] } } } } } }).components.schemas.Session
    const enumValues = session.properties.state.enum
    for (const s of allStatuses) {
      expect(enumValues).toContain(s)
    }
  })
})
