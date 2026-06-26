import { describe, it, expect, beforeEach } from 'vitest'
import { ReadyQueue } from '../ReadyQueue'

describe('ReadyQueue', () => {
  let q: ReadyQueue

  beforeEach(() => {
    q = new ReadyQueue()
  })

  describe('isReady', () => {
    it('returns true for idle, creating, needs_attention', () => {
      expect(q.isReady('idle')).toBe(true)
      expect(q.isReady('creating')).toBe(true)
      expect(q.isReady('needs_attention')).toBe(true)
    })

    it('returns false for running and stopped', () => {
      expect(q.isReady('running')).toBe(false)
      expect(q.isReady('stopped')).toBe(false)
    })
  })

  describe('onStatusChange', () => {
    it('adds session to queue when status is ready', () => {
      q.onStatusChange('sess-a', 'idle')
      expect(q.getQueue()).toEqual(['sess-a'])
    })

    it('does not duplicate sessions already in queue', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-a', 'needs_attention')
      expect(q.getQueue()).toEqual(['sess-a'])
    })

    it('removes session from queue when status is not ready', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      q.onStatusChange('sess-a', 'running')
      expect(q.getQueue()).toEqual(['sess-b'])
    })

    it('handles transition from non-ready back to ready', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-a', 'running')
      q.onStatusChange('sess-a', 'idle')
      expect(q.getQueue()).toEqual(['sess-a'])
    })
  })

  describe('onDelete', () => {
    it('removes session from queue', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      q.onDelete('sess-a')
      expect(q.getQueue()).toEqual(['sess-b'])
    })

    it('is a no-op for unknown session', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onDelete('sess-x')
      expect(q.getQueue()).toEqual(['sess-a'])
    })
  })

  describe('getQueue', () => {
    it('returns a copy, not the internal array', () => {
      q.onStatusChange('sess-a', 'idle')
      const copy = q.getQueue()
      copy.push('injected')
      expect(q.getQueue()).toEqual(['sess-a'])
    })
  })

  describe('nextReady', () => {
    it('returns null for empty queue', () => {
      expect(q.nextReady(null)).toBeNull()
      expect(q.nextReady('sess-a')).toBeNull()
    })

    it('returns first item when currentName is null', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      expect(q.nextReady(null)).toBe('sess-a')
    })

    it('returns first item when currentName is not in queue', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      expect(q.nextReady('sess-x')).toBe('sess-a')
    })

    it('wraps around to beginning', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      q.onStatusChange('sess-c', 'idle')
      expect(q.nextReady('sess-c')).toBe('sess-a')
    })

    it('advances to next in sequence', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      q.onStatusChange('sess-c', 'idle')
      expect(q.nextReady('sess-a')).toBe('sess-b')
      expect(q.nextReady('sess-b')).toBe('sess-c')
    })
  })

  describe('prevReady', () => {
    it('returns null for empty queue', () => {
      expect(q.prevReady(null)).toBeNull()
      expect(q.prevReady('sess-a')).toBeNull()
    })

    it('returns last item when currentName is null', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      expect(q.prevReady(null)).toBe('sess-b')
    })

    it('returns last item when currentName is not in queue', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      expect(q.prevReady('sess-x')).toBe('sess-b')
    })

    it('wraps around to end', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      q.onStatusChange('sess-c', 'idle')
      expect(q.prevReady('sess-a')).toBe('sess-c')
    })

    it('moves to previous in sequence', () => {
      q.onStatusChange('sess-a', 'idle')
      q.onStatusChange('sess-b', 'idle')
      q.onStatusChange('sess-c', 'idle')
      expect(q.prevReady('sess-c')).toBe('sess-b')
      expect(q.prevReady('sess-b')).toBe('sess-a')
    })
  })
})
