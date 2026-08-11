import { join } from 'node:path'

import type { Surface, SurfaceCapabilities } from '../../domain/types'
import type { RunAuthoringContext, RunAuthoringSurface, RunAuthoringTarget } from '../../slate/run-authoring'
import type { DocumentStore } from '../stores/document-store'
import { inRunSlate, isObjectiveSurface, runAliasOf } from '../stores/run-slate-projection'
import type { SurfaceService } from './surface-service'
import { parseSlateFileLocator, SLATE_DIR_PARTS, SLATE_FILE_ADAPTER } from './slate-source'

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

function projectSurface(
  service: SurfaceService,
  surface: Surface,
  runId: string,
  actor: { kind: 'session'; id: string },
): RunAuthoringSurface | null {
  const alias = runAliasOf(surface, runId)
  if (!inRunSlate(surface, alias)) return null
  const context = service.context(surface.id, { actor })
  if (!context.ok) return null
  return {
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
}

/** Resolve one current run-local owner after a mutation, including its new revision. */
export function buildRunAuthoringSurface(
  docStore: DocumentStore,
  service: SurfaceService,
  runId: string,
  localId: string,
  actor: { kind: 'session'; id: string },
): RunAuthoringSurface | null {
  const surface = docStore.surfaceForRunAlias(runId, localId)
  return surface ? projectSurface(service, surface, runId, actor) : null
}
export function buildRunAuthoringContext(
  docStore: DocumentStore,
  service: SurfaceService,
  runId: string,
  actor: { kind: 'session'; id: string },
): RunAuthoringContext {
  const projected = docStore.getSurfacesForRunAlias(runId)
    .flatMap(surface => {
      const item = projectSurface(service, surface, runId, actor)
      if (!item) return []
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
