// Local mirror of the host Tombstone shape. Plugins consume @tinstar/plugin-api
// only and must not import host domain types (ADR 0002 plugin-api boundary), so
// the fields the widget reads are duplicated here. Kept in sync with
// src/domain/types.ts `Tombstone`.
export interface Tombstone {
  convId: string
  sessionName: string
  coversSummary: string
  taskId?: string
  task?: string
  epic?: string
  initiative?: string
  workspacePath?: string
  model?: string
  created?: string
  retiredAt: string
}

/** Result shape of POST /api/graveyard/:convId/revive. */
export interface ReviveResult {
  revivable: boolean
  sessionName?: string
  reason?: string
  workspaceMissing?: boolean
}
