import { describe, it, expect } from 'vitest'
import { classifyNatsSocketError } from '../routes'

// Fake ErrnoException — matches shape of node:net socket failures
function errnoError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(message ?? code) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('classifyNatsSocketError', () => {
  it('ENOENT → UNREACHABLE (socket file gone, session not running)', () => {
    const w = classifyNatsSocketError(errnoError('ENOENT'), 'subscribe', 'tinstar.room.abc', 'sess', false)
    expect(w.code).toBe('NATS_SOCKET_UNREACHABLE')
    expect(w.restartRecommended).toBeUndefined()
    expect(w.message).toMatch(/not running/i)
  })

  it('ECONNREFUSED with file present → ORPHANED (live session, dynamic subscribe broken)', () => {
    const w = classifyNatsSocketError(errnoError('ECONNREFUSED'), 'subscribe', 'tinstar.room.xyz', 'sess', true)
    expect(w.code).toBe('NATS_SOCKET_ORPHANED')
    expect(w.restartRecommended).toBe(true)
    expect(w.message).toMatch(/orphaned/i)
    expect(w.message).toContain('tinstar.room.xyz')
  })

  it('ECONNREFUSED with file absent (TOCTOU race) → UNREACHABLE', () => {
    const w = classifyNatsSocketError(errnoError('ECONNREFUSED'), 'unsubscribe', 'tinstar.x', 'sess', false)
    expect(w.code).toBe('NATS_SOCKET_UNREACHABLE')
    expect(w.restartRecommended).toBeUndefined()
  })

  it('unexpected errno → NATS_SOCKET_ERROR', () => {
    const w = classifyNatsSocketError(errnoError('EPERM', 'permission denied'), 'subscribe', 'x', 'sess', true)
    expect(w.code).toBe('NATS_SOCKET_ERROR')
    expect(w.message).toBe('permission denied')
  })

  it('non-Error thrown → NATS_SOCKET_ERROR with stringified message', () => {
    const w = classifyNatsSocketError('boom', 'subscribe', 'x', 'sess', false)
    expect(w.code).toBe('NATS_SOCKET_ERROR')
    expect(w.message).toBe('boom')
  })
})
