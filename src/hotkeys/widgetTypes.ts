// src/hotkeys/widgetTypes.ts

export interface Binding {
  /** e.code-based key string, e.g. 'KeyS', 'Backslash', 'Ctrl+Backslash' */
  key: string
  /** Human-readable label shown in sidebar, e.g. 'Enter terminal' */
  label: string
  /** Action identifier dispatched to the widget instance */
  action: string
  /** If true: only shown during chord state */
  chord?: boolean
}

export interface WidgetContext {
  /** e.code-based key that navigates into this context */
  key: string
  /** Human-readable label, e.g. 'Terminal', 'Files' */
  label: string
  /** Sub-widget type that becomes active */
  type: string
  /** If true: sets chordState instead of pushing focus path */
  transient?: boolean
}

export interface WidgetDefinition {
  /** e.g. 'run-workspace' | 'group-container' | 'canvas' */
  type: string
  /** Shown in sidebar header */
  displayName: string
  /** Navigable sub-elements this widget exposes */
  contexts: WidgetContext[]
  /** Direct actions when this widget is the active focus */
  bindings: Binding[]
}

/**
 * Focus zones within RunWorkspaceWidget — kept here so RunWorkspaceWidget
 * can import it after useWidgetHotkeys.ts is deleted.
 */
export type FocusZone = 'left-tab' | 'file-list' | 'center-tabs' | 'slate' | 'right-panel'

/** Format a key code string for human-readable display in the hotkeys sidebar */
export function formatKey(key: string): string {
  return key.split('+').map(part => {
    const keyCode = part.match(/^Key([A-Z])$/)
    if (keyCode) return keyCode[1]
    const digit = part.match(/^Digit(\d)$/)
    if (digit) return digit[1]
    if (part === 'ArrowUp') return '↑'
    if (part === 'ArrowDown') return '↓'
    if (part === 'ArrowLeft') return '←'
    if (part === 'ArrowRight') return '→'
    return part
  }).join('+')
}
