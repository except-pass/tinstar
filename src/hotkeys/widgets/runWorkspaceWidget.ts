// src/hotkeys/widgets/runWorkspaceWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'run-workspace',
  displayName: 'Agent Session',
  contexts: [
    { key: 'Ctrl+Backslash', type: 'run-terminal', label: 'Terminal' },
  ],
  bindings: [
    { key: 'Tab',        label: 'Next panel',        action: 'focus-next' },
    { key: 'Shift+Tab',  label: 'Prev panel',        action: 'focus-prev' },
    { key: 'ArrowDown',  label: 'Down in file list', action: 'file-down' },
    { key: 'ArrowUp',    label: 'Up in file list',   action: 'file-up' },
    { key: 'ArrowRight', label: 'Next tab',          action: 'tab-next' },
    { key: 'ArrowLeft',  label: 'Prev tab',          action: 'tab-prev' },
    { key: 'Enter',      label: 'Activate',          action: 'activate' },
    { key: 'KeyP',       label: 'Prompt composer',   action: 'toggle-prompt' },
    { key: 'KeyZ',       label: 'Fit to viewport',   action: 'fit-viewport' },
    // The Slate's keys (S6 U1). They ride the registry rather than a bespoke
    // listener so the confirmation flash lands on the sidebar ROW (via the router's
    // emitBindingFired) and so they show up in the hotkeys sidebar. The handler in
    // RunWorkspaceWidget gates each on `focusZone === 'slate'`; the router already
    // suppresses all of them inside an editable element, so typing in the composer,
    // the search field, or the add-a-point input is safe.
    //
    // `?` (the cheatsheet) is deliberately NOT here: useGlobalHotkeys already owns
    // it for the command palette, so a Shift+Slash binding would double-fire. It
    // lives in SlatePanel's capture-phase shim instead — see slateHotkeys.ts.
    { key: 'KeyJ',       label: 'Slate: focus next',     action: 'slate-focus-next' },
    { key: 'KeyK',       label: 'Slate: focus prev',     action: 'slate-focus-prev' },
    { key: 'KeyX',       label: 'Slate: hide focused',   action: 'slate-hide-focused' },
    { key: 'KeyR',       label: 'Slate: refresh focused', action: 'slate-refresh-focused' },
    { key: 'KeyC',       label: 'Slate: compose',        action: 'slate-compose' },
    { key: 'Slash',      label: 'Slate: search',         action: 'slate-search' },
  ],
})
