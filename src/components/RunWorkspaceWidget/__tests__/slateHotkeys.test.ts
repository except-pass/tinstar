import { describe, it, expect } from 'vitest'
import { SLATE_HOTKEYS, keyToSlateAction, type SlateKeyEvent } from '../slateHotkeys'
import { getWidget } from '../../../hotkeys/widgetRegistry'
import '../../../hotkeys/widgets/runWorkspaceWidget' // side-effect: registers the widget

function ev(over: Partial<SlateKeyEvent> & { code: string }): SlateKeyEvent {
  return { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over }
}

describe('keyToSlateAction (S6 U1)', () => {
  it('maps each bare key to its action', () => {
    expect(keyToSlateAction(ev({ code: 'KeyJ' }))).toBe('focus-next')
    expect(keyToSlateAction(ev({ code: 'KeyK' }))).toBe('focus-prev')
    expect(keyToSlateAction(ev({ code: 'KeyX' }))).toBe('hide')
    expect(keyToSlateAction(ev({ code: 'KeyR' }))).toBe('refresh')
    expect(keyToSlateAction(ev({ code: 'KeyC' }))).toBe('compose')
    expect(keyToSlateAction(ev({ code: 'Slash' }))).toBe('search')
  })

  it('distinguishes / from ? by the Shift state', () => {
    expect(keyToSlateAction(ev({ code: 'Slash' }))).toBe('search')
    expect(keyToSlateAction(ev({ code: 'Slash', shiftKey: true }))).toBe('cheatsheet')
    // A shifted letter is NOT the bare key — J and j are different asks.
    expect(keyToSlateAction(ev({ code: 'KeyJ', shiftKey: true }))).toBeNull()
  })

  it('refuses anything carrying Ctrl / Meta / Alt', () => {
    // Ctrl+R must stay "reload the page", not "refresh the focused surface".
    expect(keyToSlateAction(ev({ code: 'KeyR', ctrlKey: true }))).toBeNull()
    expect(keyToSlateAction(ev({ code: 'KeyR', metaKey: true }))).toBeNull()
    expect(keyToSlateAction(ev({ code: 'Slash', shiftKey: true, altKey: true }))).toBeNull()
  })

  it('returns null for keys that are not ours', () => {
    expect(keyToSlateAction(ev({ code: 'KeyQ' }))).toBeNull()
    expect(keyToSlateAction(ev({ code: 'Escape' }))).toBeNull()
  })

  it('declares a registry binding for every key EXCEPT ?', () => {
    // The whole point of the split: six keys ride the widget-binding registry (which
    // is what puts the confirmation flash on the sidebar row), and `?` alone is the
    // capture-shim exception because useGlobalHotkeys already owns it.
    const withoutBinding = SLATE_HOTKEYS.filter(h => !h.binding)
    expect(withoutBinding.map(h => h.key)).toEqual(['?'])
    expect(SLATE_HOTKEYS.filter(h => h.binding)).toHaveLength(6)
  })
})

describe('the Slate keys are really registered on the run-workspace widget', () => {
  // The wiring guard. If a binding is dropped from runWorkspaceWidget.ts the key
  // simply stops working — no error, no failing render — and the sidebar-row flash
  // (which the router emits, not the panel) disappears with it.
  it('registers every non-? key with a matching code and action', () => {
    const def = getWidget('run-workspace')
    expect(def).toBeDefined()
    for (const h of SLATE_HOTKEYS) {
      if (!h.binding) continue
      const binding = def!.bindings.find(b => b.action === h.binding)
      expect(binding, `no binding registered for ${h.binding}`).toBeDefined()
      expect(binding!.key).toBe(h.code)
    }
  })

  it('does NOT register ? — that would double-fire with the command palette', () => {
    const def = getWidget('run-workspace')!
    expect(def.bindings.some(b => b.key === 'Shift+Slash')).toBe(false)
    expect(def.bindings.some(b => b.key === '?')).toBe(false)
  })
})
