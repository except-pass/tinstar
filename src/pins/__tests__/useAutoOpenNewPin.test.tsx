// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAutoOpenNewPin } from '../useAutoOpenNewPin'
import type { Pin } from '../../domain/pinSet'

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1', nodeId: 'n1', nx: 0.5, ny: 0.5, comment: '', createdAt: Date.now(), ...over,
})

function setup(initial: Pin[]) {
  const open = vi.fn()
  const { rerender } = renderHook(({ pins }) => useAutoOpenNewPin(pins, open), {
    initialProps: { pins: initial },
  })
  return { open, rerender: (pins: Pin[]) => rerender({ pins }) }
}

describe('useAutoOpenNewPin', () => {
  it('opens a freshly dropped note that appears after mount', () => {
    const { open, rerender } = setup([])
    rerender([pin({ id: 'fresh' })])
    expect(open).toHaveBeenCalledWith('fresh')
  })

  it('does NOT open pins that were already present on mount', () => {
    const { open, rerender } = setup([pin({ id: 'existing' })])
    rerender([pin({ id: 'existing' })]) // same set, re-render
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT open a newly-appeared pin that is already sent', () => {
    const { open, rerender } = setup([])
    rerender([pin({ id: 'sent', sentAt: Date.now() })])
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT open a newly-appeared pin that already has a comment', () => {
    const { open, rerender } = setup([])
    rerender([pin({ id: 'commented', comment: 'already typed' })])
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT open a stale pin arriving via hydration (old createdAt)', () => {
    const { open, rerender } = setup([])
    rerender([pin({ id: 'hydrated', createdAt: Date.now() - 60_000 })])
    expect(open).not.toHaveBeenCalled()
  })

  it('opens each fresh pin only once (closing it does not reopen)', () => {
    const { open, rerender } = setup([])
    rerender([pin({ id: 'fresh' })])
    rerender([pin({ id: 'fresh' })]) // user closed bubble; pin still in list
    expect(open).toHaveBeenCalledTimes(1)
  })
})
