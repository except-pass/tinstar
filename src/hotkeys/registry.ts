// src/hotkeys/registry.ts
import type { HotkeyScope } from './ActiveScopeContext'

export interface HotkeyDef {
  id: string
  keys: string   // human-readable, e.g. 'Ctrl+1', 'Shift+]'
  scope: HotkeyScope
  category: string
  description: string
}

export const HOTKEYS: HotkeyDef[] = [
  // --- General ---
  { id: 'palette-open',       keys: '?',             scope: 'global', category: 'General',    description: 'Open command palette' },

  // --- Sessions ---
  { id: 'session-new',        keys: 'Ctrl+Enter',    scope: 'global', category: 'Sessions',   description: 'New session for selected entity' },
  { id: 'cycle-ready-next',   keys: ']',             scope: 'global', category: 'Sessions',   description: 'Next ready-for-input session' },
  { id: 'cycle-ready-prev',   keys: '[',             scope: 'global', category: 'Sessions',   description: 'Previous ready-for-input session' },
  { id: 'cycle-all-next',     keys: 'Shift+]',       scope: 'global', category: 'Sessions',   description: 'Next session (all)' },
  { id: 'cycle-all-prev',     keys: 'Shift+[',       scope: 'global', category: 'Sessions',   description: 'Previous session (all)' },

  // --- Terminal ---
  { id: 'terminal-toggle',    keys: 'Ctrl+Shift+\\', scope: 'widget', category: 'Terminal',   description: 'Toggle terminal / widget focus' },

  // --- Widget navigation ---
  { id: 'focus-next-zone',    keys: 'Tab',           scope: 'widget', category: 'Navigation', description: 'Next panel zone' },
  { id: 'focus-prev-zone',    keys: 'Shift+Tab',     scope: 'widget', category: 'Navigation', description: 'Previous panel zone' },
  { id: 'file-down',          keys: '↓',             scope: 'widget', category: 'Navigation', description: 'Move down in file list' },
  { id: 'file-up',            keys: '↑',             scope: 'widget', category: 'Navigation', description: 'Move up in file list' },
  { id: 'tab-prev',           keys: '←',             scope: 'widget', category: 'Navigation', description: 'Previous center tab' },
  { id: 'tab-next',           keys: '→',             scope: 'widget', category: 'Navigation', description: 'Next center tab' },
  { id: 'activate',           keys: 'Enter',         scope: 'widget', category: 'Navigation', description: 'Open file / activate procedure' },

  // --- Hotgroups ---
  ...([1,2,3,4,5,6,7,8,9,0] as const).map(n => ({
    id: `hotgroup-select-${n}`,
    keys: `${n}`,
    scope: 'canvas' as HotkeyScope,
    category: 'Hotgroups',
    description: `Select hotgroup ${n === 0 ? '0 (slot 10)' : n}`,
  })),
  ...([1,2,3,4,5,6,7,8,9,0] as const).map(n => ({
    id: `hotgroup-assign-${n}`,
    keys: `Ctrl+${n}`,
    scope: 'canvas' as HotkeyScope,
    category: 'Hotgroups',
    description: `Add selection to hotgroup ${n === 0 ? '0 (slot 10)' : n}`,
  })),
  ...([1,2,3,4,5,6,7,8,9,0] as const).map(n => ({
    id: `hotgroup-remove-${n}`,
    keys: `Ctrl+Shift+${n}`,
    scope: 'canvas' as HotkeyScope,
    category: 'Hotgroups',
    description: `Remove selection from hotgroup ${n === 0 ? '0 (slot 10)' : n}`,
  })),

  // --- Layout ---
  { id: 'arrange-grid',       keys: 'Ctrl+G',        scope: 'canvas', category: 'Layout',     description: 'Arrange grid' },
  { id: 'arrange-reset',      keys: 'Ctrl+Shift+G',  scope: 'canvas', category: 'Layout',     description: 'Reset layout' },

  // --- Canvas navigation (existing, now registered) ---
  { id: 'pan-mode',           keys: 'Space (hold)',  scope: 'canvas', category: 'Navigation', description: 'Pan mode' },
  { id: 'zoom-reset',         keys: 'Alt+Z',         scope: 'canvas', category: 'Navigation', description: 'Reset zoom to 100%' },
  { id: 'zoom-scroll',        keys: 'Ctrl+Scroll',   scope: 'canvas', category: 'Navigation', description: 'Zoom to cursor' },
]
