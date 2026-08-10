import { join } from 'node:path'

import type {
  Surface,
  SurfaceCapabilities,
  SurfaceContentAuthority,
  SurfaceCreation,
  SurfaceFreshness,
  PointAuthor,
  PointStatus,
} from '../../domain/types'
import type { DocumentStore } from '../stores/document-store'
import { inRunSlate, isObjectiveSurface, runAliasOf } from '../stores/run-slate-projection'
import type { SurfaceService } from './surface-service'
import { parseSlateFileLocator, SLATE_DIR_PARTS, SLATE_FILE_ADAPTER } from './slate-source'

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

function targetFor(surface: Surface, capabilities: SurfaceCapabilities): RunAuthoringTarget {
  if (surface.source?.adapter === SLATE_FILE_ADAPTER && surface.source.worktree) {
    const locator = parseSlateFileLocator(surface.source.locator)
    if (locator) {
      return {
        kind: 'slate-file',
        file: join(surface.source.worktree, ...SLATE_DIR_PARTS, locator.file),
        localId: locator.localId,
        ...(surface.creation?.phase === 'authoring'
          ? { attemptToken: surface.creation.token }
          : {}),
      }
    }
  }
  if (surface.contentAuthority === 'canonical-direct') {
    return {
      kind: 'canonical-content',
      method: 'PATCH',
      endpoint: `/api/surfaces/${encodeURIComponent(surface.id)}/content`,
      expectedRev: surface.rev,
    }
  }
  return {
    kind: 'unavailable',
    reason: capabilities.blocked?.updateContent
      ?? 'this Surface has no writable source destination',
  }
}
export function buildRunAuthoringContext(
  docStore: DocumentStore,
  service: SurfaceService,
  runId: string,
  actor: { kind: 'session'; id: string },
): RunAuthoringContext {
  const projected = docStore.getSurfacesForRunAlias(runId)
    .flatMap(surface => {
      const alias = runAliasOf(surface, runId)
      if (!inRunSlate(surface, alias)) return []
      const context = service.context(surface.id, { actor })
      if (!context.ok) return []
      const item: RunAuthoringSurface = {
        surfaceId: surface.id,
        localId: alias.localId,
        headline: surface.content.headline,
        author: surface.author,
        status: surface.thread.status,
        contentAuthority: surface.contentAuthority,
        target: targetFor(surface, context.data.capabilities),
        capabilities: context.data.capabilities,
        freshness: surface.freshness,
        ...(surface.creation ? { creation: surface.creation } : {}),
      }
      return [{ surface, item }]
    })
    .sort((a, b) => (a.surface.order ?? a.surface.createdAt) - (b.surface.order ?? b.surface.createdAt))

  const objective = projected.find(({ surface, item }) => (
    isObjectiveSurface(surface, item.localId)
  ))?.item ?? null
  return {
    runId,
    objective,
    surfaces: projected
      .filter(({ surface, item }) => !isObjectiveSurface(surface, item.localId))
      .map(({ item }) => item),
  }
}
