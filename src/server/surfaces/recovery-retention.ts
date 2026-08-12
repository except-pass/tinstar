// Recovery-store retention (plan R31 / KTD15).
//
// Deletion is a move into the per-space recovery store. Retention must be bounded
// and stated: past the bound, an automatic purge is the only irreversible path,
// and it must still go through SurfaceService.purge so descendant CAS and durable
// commit stay intact. This module is the sweeper — not a second erase path.

import type { Surface } from '../../domain/types'
import type { DocumentStore } from '../stores/document-store'
import { log } from '../logger'
import { SurfaceService, type SurfaceCallContext } from './surface-service'

/** Default: seven days in the recovery store, then automatic purge. */
export const DEFAULT_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Default sweep cadence. Hourly is enough; purge is not latency-sensitive. */
export const DEFAULT_RECOVERY_SWEEP_MS = 60 * 60 * 1000

export const RECOVERY_RETENTION_ACTOR = {
  kind: 'process' as const,
  id: 'recovery-retention',
}

const RETENTION_CTX: SurfaceCallContext = { actor: RECOVERY_RETENTION_ACTOR }

/**
 * Recovery roots whose `deleted.at` is at or past the retention bound.
 *
 * `retentionMs <= 0` disables automatic purge (returns nothing). Roots without a
 * usable `deleted.at` are skipped rather than guessed — the stamp is what makes
 * the bound meaningful.
 */
export function recoveryRootsPastRetention(
  roots: readonly Surface[],
  retentionMs: number,
  now: number,
): Surface[] {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return []
  return roots.filter(root => {
    const at = root.deleted?.at
    return typeof at === 'number' && Number.isFinite(at) && now - at >= retentionMs
  })
}

export interface RecoveryRetentionSweepResult {
  examined: number
  purged: string[]
  failed: Array<{ id: string; message: string }>
}

/**
 * Purge every recovery root in every space that has aged past `retentionMs`.
 *
 * Passes the live descendant set into `purge` so a non-empty deleted subtree is
 * erased atomically under the same compare-and-swap a human/CLI purge uses.
 */
export async function sweepExpiredRecovery(opts: {
  docStore: DocumentStore
  service: SurfaceService
  retentionMs: number
  now?: number
}): Promise<RecoveryRetentionSweepResult> {
  const now = opts.now ?? Date.now()
  const purged: string[] = []
  const failed: Array<{ id: string; message: string }> = []
  let examined = 0

  if (!Number.isFinite(opts.retentionMs) || opts.retentionMs <= 0) {
    return { examined: 0, purged, failed }
  }

  for (const space of opts.docStore.getAllSpaces()) {
    const roots = opts.docStore.getSurfaceRecoveryRoots(space.id)
    const expired = recoveryRootsPastRetention(roots, opts.retentionMs, now)
    examined += roots.length
    for (const root of expired) {
      const descendants = opts.docStore.getSurfaceDescendants(root.id).map(s => s.id)
      try {
        const result = await opts.service.purge(
          root.id,
          { descendants },
          RETENTION_CTX,
        )
        if (result.ok) {
          purged.push(root.id, ...descendants)
        } else {
          failed.push({ id: root.id, message: result.error.message })
        }
      } catch (err) {
        failed.push({ id: root.id, message: (err as Error).message })
      }
    }
  }

  if (purged.length || failed.length) {
    log.info('recovery-retention', `sweep purged ${purged.length} surface(s), failed ${failed.length}`, {
      retentionMs: opts.retentionMs,
      examined,
      purged: purged.length,
      failed: failed.length,
    })
  }

  return { examined, purged, failed }
}

/** Start the periodic sweeper. Returns a stop handle. */
export function startRecoveryRetentionSweep(opts: {
  docStore: DocumentStore
  retentionMs: number
  sweepMs: number
  service?: SurfaceService
  now?: () => number
}): { stop: () => void } {
  const service = opts.service ?? new SurfaceService(opts.docStore)
  const sweepMs = Math.max(5_000, opts.sweepMs || DEFAULT_RECOVERY_SWEEP_MS)
  let running = false

  const tick = () => {
    if (running) return
    if (!Number.isFinite(opts.retentionMs) || opts.retentionMs <= 0) return
    running = true
    void sweepExpiredRecovery({
      docStore: opts.docStore,
      service,
      retentionMs: opts.retentionMs,
      now: opts.now?.(),
    })
      .catch(err => log.warn('recovery-retention', `sweep failed: ${(err as Error).message}`))
      .finally(() => { running = false })
  }

  // Run once shortly after boot so a long-lived recovery backlog is cleared
  // without waiting a full sweep interval.
  const boot = setTimeout(tick, 15_000)
  boot.unref?.()
  const timer = setInterval(tick, sweepMs)
  timer.unref?.()

  return {
    stop: () => {
      clearTimeout(boot)
      clearInterval(timer)
    },
  }
}
