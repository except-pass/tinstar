import type { DocumentStore } from '../stores/document-store'
import type { SurfacePrincipalRef } from '../../domain/types'
import type { SurfaceAuthorOutcome } from '../sessions/surfaceAuthor'
import type { SurfaceService } from './surface-service'
import { parseSlateFileLocator } from './slate-source'
import { log } from '../logger'

const ACTOR: SurfacePrincipalRef = { kind: 'job', id: 'surface-compose', label: 'Surface composer' }

export interface ComposeRecoveryResult {
  failed: string[]
}

/** Owns the host-observed end of compose attempts: process exits, deadlines, and
 * restart recovery. File validity and token matching remain in the reconciler. */
export class SurfaceComposeCoordinator {
  constructor(
    private readonly docStore: DocumentStore,
    private readonly service: SurfaceService,
    private readonly reobserveRun: (runId: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  watch(surfaceId: string, token: string, completion: Promise<SurfaceAuthorOutcome> | undefined): void {
    if (!completion) return
    void completion
      .then(outcome => this.settleExit(surfaceId, token, outcome))
      .catch(err => log.warn('slate-author', `compose exit settlement failed: ${(err as Error).message}`))
  }

  async settleExit(surfaceId: string, token: string, outcome: SurfaceAuthorOutcome): Promise<void> {
    // Zero means only that the process stopped cleanly. The watched file is the
    // success signal; if it never arrives the saved deadline will end the attempt.
    if (outcome.code === 0 && !outcome.error && !outcome.timedOut) return
    const prior = this.docStore.getSurface(surfaceId)
    const runId = prior?.provenance?.runId
    if (runId) await this.reobserveRun(runId)
    const current = this.docStore.getSurface(surfaceId)
    if (!current?.creation || current.creation.phase !== 'authoring' || current.creation.token !== token) return
    await this.service.failComposition(surfaceId, {
      token,
      expectedRev: current.rev,
      code: outcome.timedOut ? 'timed-out' : 'author-failed',
      message: outcome.timedOut
        ? 'Creating this card took too long. You can retry it.'
        : 'The author stopped before this card was ready. You can retry it.',
    }, { actor: ACTOR, at: this.now() })
  }

  /** Turn a parsed-but-invalid assigned entry into an immediate useful failure.
   *  A mismatched token belongs to an older attempt and cannot affect the current one. */
  async rejectInvalidOutput(runId: string, file: string, localId: string, token?: string): Promise<void> {
    const current = this.docStore.surfaceForRunAlias(runId, localId)
    if (current?.creation?.phase !== 'authoring') return
    const destination = current.source ? parseSlateFileLocator(current.source.locator) : null
    if (!destination || destination.file !== file || destination.localId !== localId) return
    if (token && token !== current.creation.token) return
    await this.service.failComposition(current.id, {
      token: current.creation.token,
      expectedRev: current.rev,
      code: 'invalid-content',
      message: 'The author returned content this card could not display. You can retry it.',
    }, { actor: ACTOR, at: this.now() })
  }

  async sweep(): Promise<string[]> {
    const failed: string[] = []
    const now = this.now()
    const observedRuns = new Set<string>()
    for (const surface of this.docStore.getAllSurfaces()) {
      if (surface.creation?.phase !== 'authoring' || surface.creation.deadlineAt > now) continue
      const runId = surface.provenance?.runId
      if (runId && !observedRuns.has(runId)) {
        await this.reobserveRun(runId)
        observedRuns.add(runId)
      }
      const current = this.docStore.getSurface(surface.id)
      if (current?.creation?.phase !== 'authoring' || current.creation.token !== surface.creation.token) continue
      const result = await this.service.failComposition(current.id, {
        token: current.creation.token,
        expectedRev: current.rev,
        code: 'timed-out',
        message: 'Creating this card took too long. You can retry it.',
      }, { actor: ACTOR, at: now })
      if (result.ok) failed.push(current.id)
    }
    return failed
  }

  async recover(): Promise<ComposeRecoveryResult> {
    const failed: string[] = []
    const observedRuns = new Set<string>()
    for (const surface of this.docStore.getAllSurfaces()) {
      if (surface.creation?.phase !== 'authoring') continue
      const runId = surface.provenance?.runId
      if (runId && !observedRuns.has(runId)) {
        await this.reobserveRun(runId)
        observedRuns.add(runId)
      }
      const current = this.docStore.getSurface(surface.id)
      if (current?.creation?.phase !== 'authoring' || current.creation.token !== surface.creation.token) continue
      const result = await this.service.failComposition(current.id, {
        token: current.creation.token,
        expectedRev: current.rev,
        code: 'restarted',
        message: 'The app restarted while this card was being created. You can retry it.',
      }, { actor: ACTOR, at: this.now() })
      if (result.ok) failed.push(current.id)
    }
    return { failed }
  }

}
