// ADR 0002 permits built-in plugins to `import type` host domain types (a
// type-only import erases at build time and doesn't breach the runtime boundary),
// which sibling plugins (browser, image-viewer, file-editor) already do. Import
// Tombstone directly rather than hand-copying it, so the widget can't drift from
// the server shape. ReviveResult stays local — its source (NecroResult) lives in
// server-only code plugins can't import.
export type { Tombstone } from '../../../domain/types'

/** Result shape of POST /api/graveyard/:convId/revive. */
export interface ReviveResult {
  revivable: boolean
  sessionName?: string
  reason?: string
  workspaceMissing?: boolean
  restoredFromSnapshot?: boolean
}
