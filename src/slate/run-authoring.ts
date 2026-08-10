import type {
  PointAuthor,
  PointStatus,
  SurfaceCapabilities,
  SurfaceContentAuthority,
  SurfaceCreation,
  SurfaceFreshness,
} from '../domain/types'

/** The exact destination a foreground agent may use to amend one visible Surface. */
export type RunAuthoringTarget =
  | {
      kind: 'slate-file'
      file: string
      localId: string
      attemptToken?: string
    }
  | {
      kind: 'canonical-content'
      method: 'PATCH'
      endpoint: string
      expectedRev: number
    }
  | {
      kind: 'unavailable'
      reason: string
    }

export interface RunAuthoringSurface {
  surfaceId: string
  localId: string
  headline: string
  author: PointAuthor
  status: PointStatus
  contentAuthority: SurfaceContentAuthority
  target: RunAuthoringTarget
  capabilities: SurfaceCapabilities
  freshness: SurfaceFreshness
  creation?: SurfaceCreation
}

export interface RunAuthoringContext {
  runId: string
  objective: RunAuthoringSurface | null
  surfaces: RunAuthoringSurface[]
}
