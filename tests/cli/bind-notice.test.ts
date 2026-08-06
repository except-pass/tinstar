import { describe, expect, it, vi } from 'vitest'
import {
  announceBindChangeOnce,
  bindChangeNotice,
  type BindNoticeStore,
} from '../../src/server/bindNotice'

function memoryStore(initial: string | null = null): BindNoticeStore & { value: string | null } {
  const state = { value: initial }
  return {
    get value() { return state.value },
    read: () => state.value,
    write: (v: string) => { state.value = v },
  }
}

describe('bindChangeNotice — what the operator is told', () => {
  it('names the breaking change and the interim restore path', () => {
    const text = bindChangeNotice()
    expect(text).toMatch(/loopback/i)
    expect(text).toContain('--host')
  })

  it('does not name a reach command that does not exist in this release', () => {
    // The notice ships WITH the bind flip, one release before reach. Naming a
    // command the operator cannot run is worse than naming nothing.
    const text = bindChangeNotice().toLowerCase()
    expect(text).not.toContain('tinstar reach')
    expect(text).not.toContain('tailscale')
  })

  it('warns that inherited terminals are replaced once', () => {
    expect(bindChangeNotice()).toMatch(/terminal/i)
  })
})

describe('announceBindChangeOnce — fires once, on an upgrade only', () => {
  it('fires on the first start after the change', () => {
    const store = memoryStore()
    const emit = vi.fn()

    expect(announceBindChangeOnce(store, emit, { existingInstall: true })).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0]).toContain('--host')
  })

  it('stays quiet on every start after that', () => {
    const store = memoryStore()
    const emit = vi.fn()

    announceBindChangeOnce(store, emit, { existingInstall: true })
    announceBindChangeOnce(store, emit, { existingInstall: true })
    announceBindChangeOnce(store, emit, { existingInstall: true })

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('stays quiet on a fresh install, which never had the old behaviour', () => {
    const store = memoryStore()
    const emit = vi.fn()

    expect(announceBindChangeOnce(store, emit, { existingInstall: false })).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('records the marker on a fresh install too, so it never fires later', () => {
    // Otherwise the first restart of a brand-new install looks like an upgrade
    // and the operator gets a migration notice for a migration that never was.
    const store = memoryStore()
    const emit = vi.fn()

    announceBindChangeOnce(store, emit, { existingInstall: false })
    announceBindChangeOnce(store, emit, { existingInstall: true })

    expect(emit).not.toHaveBeenCalled()
  })

  it('survives a store that cannot be written', () => {
    // A read-only config dir must not stop the server from starting; the cost
    // is a repeated notice, which is the harmless direction.
    const store: BindNoticeStore = {
      read: () => null,
      write: () => { throw new Error('EACCES') },
    }
    const emit = vi.fn()

    expect(() => announceBindChangeOnce(store, emit, { existingInstall: true }))
      .not.toThrow()
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
