// The Slate's keyboard vocabulary (S6 U1) — one table, two consumers.
//
// Six of the seven keys ride the EXISTING widget-binding registry
// (src/hotkeys/widgets/runWorkspaceWidget.ts → contextRouter → dispatchAction), which
// is what makes the confirmation flash land on the SIDEBAR ROW rather than on the
// widget, and what puts them in the hotkeys sidebar for free.
//
// `?` is the exception. `useGlobalHotkeys` already claims `?` (Shift+Slash) for the
// command palette, guarded only by `isEditable` — it knows nothing about focus zones.
// A registry binding for Shift+Slash would therefore double-fire: palette AND
// cheatsheet. So `?` alone is handled by a narrow capture-phase listener inside
// SlatePanel, armed only while the Slate zone holds focus, which stops the event
// before the global listener can see it.
//
// This module is the single source of truth both paths read: the shim asks
// `keyToSlateAction`, and the cheatsheet overlay renders `SLATE_HOTKEYS`. Pure and
// React-free so the mapping is unit-testable without a DOM.

export type SlateHotkeyAction =
  | 'focus-next'
  | 'focus-prev'
  | 'hide'
  | 'refresh'
  | 'compose'
  | 'search'
  | 'cheatsheet'

export interface SlateHotkey {
  /** What the user presses, as the cheatsheet prints it. */
  key: string
  /** The physical `KeyboardEvent.code` — layout-independent, and what the context
   *  router normalizes against. */
  code: string
  /** Shift must be held (only `?`). */
  shift?: boolean
  label: string
  action: SlateHotkeyAction
  /** The widget-registry action name, when this key rides the registry. `?` has
   *  none — it is the capture-shim exception. */
  binding?: string
}

/** The Slate's keys, in the order the cheatsheet lists them. */
export const SLATE_HOTKEYS: readonly SlateHotkey[] = [
  { key: 'j', code: 'KeyJ',  label: 'Focus next surface',  action: 'focus-next', binding: 'slate-focus-next' },
  { key: 'k', code: 'KeyK',  label: 'Focus previous',      action: 'focus-prev', binding: 'slate-focus-prev' },
  { key: 'x', code: 'KeyX',  label: 'Hide focused',        action: 'hide',       binding: 'slate-hide-focused' },
  { key: 'r', code: 'KeyR',  label: 'Refresh focused',     action: 'refresh',    binding: 'slate-refresh-focused' },
  { key: 'c', code: 'KeyC',  label: 'Compose a surface',   action: 'compose',    binding: 'slate-compose' },
  { key: '/', code: 'Slash', label: 'Search the Slate',    action: 'search',     binding: 'slate-search' },
  { key: '?', code: 'Slash', shift: true, label: 'This cheatsheet', action: 'cheatsheet' },
] as const

/** The subset of a KeyboardEvent this mapping depends on. */
export interface SlateKeyEvent {
  code: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * Map a keystroke to a Slate action, or null when it isn't one of ours.
 *
 * Any modifier beyond the declared Shift disqualifies the key — Ctrl+R must stay
 * "reload the page", not "refresh the focused surface".
 */
export function keyToSlateAction(e: SlateKeyEvent): SlateHotkeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  for (const h of SLATE_HOTKEYS) {
    if (h.code !== e.code) continue
    if (Boolean(h.shift) !== e.shiftKey) continue
    return h.action
  }
  return null
}
