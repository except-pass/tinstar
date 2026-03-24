// src/hotkeys/widgetRegistry.ts
import type { WidgetDefinition } from './widgetTypes'

// Tier-1 reserved keys — exact e.code format strings (+ modifier prefix)
// Any WidgetDefinition binding/context key matching one of these throws at registration.
const RESERVED_KEYS = new Set([
  'Backquote',           // ` root key
  'BracketLeft',         // [ cycle prev
  'BracketRight',        // ] cycle next
  'Shift+BracketLeft',   // Shift+[ cycle all prev
  'Shift+BracketRight',  // Shift+] cycle all next
  '?',                   // open palette (e.key '?' fires as Shift+Slash but checked as '?')
  'KeyS',                // new session
  'Ctrl+KeyG',           // arrange grid
  'Ctrl+Shift+KeyG',     // arrange reset
  'Ctrl+KeyL',           // arrange swim lanes
  'Ctrl+Digit1', 'Ctrl+Digit2', 'Ctrl+Digit3', 'Ctrl+Digit4', 'Ctrl+Digit5',
  'Ctrl+Digit6', 'Ctrl+Digit7', 'Ctrl+Digit8', 'Ctrl+Digit9', 'Ctrl+Digit0',
  'Ctrl+Shift+Digit1', 'Ctrl+Shift+Digit2', 'Ctrl+Shift+Digit3', 'Ctrl+Shift+Digit4', 'Ctrl+Shift+Digit5',
  'Ctrl+Shift+Digit6', 'Ctrl+Shift+Digit7', 'Ctrl+Shift+Digit8', 'Ctrl+Shift+Digit9', 'Ctrl+Shift+Digit0',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
])

const registry = new Map<string, WidgetDefinition>()

export function registerWidget(def: WidgetDefinition): void {
  // 1. Duplicate type check
  if (registry.has(def.type)) {
    throw new Error(`[widgetRegistry] duplicate widget type: "${def.type}"`)
  }

  // 2. Reserved key check
  const allKeys = [
    ...def.bindings.map(b => b.key),
    ...def.contexts.map(c => c.key),
  ]
  for (const key of allKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[widgetRegistry] widget "${def.type}" claims reserved key "${key}"`
      )
    }
  }

  // 3. Intra-definition conflict check
  const bindingKeys = new Set(def.bindings.map(b => b.key))
  for (const ctx of def.contexts) {
    if (bindingKeys.has(ctx.key)) {
      throw new Error(
        `[widgetRegistry] widget "${def.type}" key "${ctx.key}" appears in both contexts and bindings`
      )
    }
  }

  registry.set(def.type, def)
}

export function getWidget(type: string): WidgetDefinition | undefined {
  return registry.get(type)
}

export function getAllWidgets(): WidgetDefinition[] {
  return [...registry.values()]
}

/** For testing only — clears the registry */
export function _clearRegistry(): void {
  registry.clear()
}
