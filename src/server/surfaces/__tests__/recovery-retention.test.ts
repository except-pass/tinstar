import { describe, it, expect } from 'vitest'
import {
  recoveryRootsPastRetention,
  DEFAULT_RECOVERY_RETENTION_MS,
} from '../recovery-retention'
import type { Surface } from '../../../domain/types'

function root(partial: {
  id: string
  deletedAt?: number
}): Surface {
  return {
    id: partial.id,
    spaceId: 'spc-test',
    home: { kind: 'recovery', spaceId: 'spc-test' },
    content: { headline: partial.id },
    contentAuthority: 'canonical-direct',
    provenance: {},
    author: 'agent',
    thread: { replies: [], status: 'open' },
    freshness: { phase: 'current', overdue: false },
    aliases: [],
    rev: 1,
    homeRev: 1,
    createdAt: 1,
    amendedAt: 1,
    ...(partial.deletedAt !== undefined
      ? {
          deleted: {
            at: partial.deletedAt,
            formerHome: { kind: 'canvas', spaceId: 'spc-test' },
            disposition: 'delete-subtree' as const,
          },
        }
      : {}),
  } as Surface
}

describe('recoveryRootsPastRetention', () => {
  const now = 1_000_000_000_000

  it('returns roots at or past the retention bound', () => {
    const fresh = root({ id: 'fresh', deletedAt: now - DEFAULT_RECOVERY_RETENTION_MS + 1 })
    const expired = root({ id: 'expired', deletedAt: now - DEFAULT_RECOVERY_RETENTION_MS })
    const older = root({ id: 'older', deletedAt: now - DEFAULT_RECOVERY_RETENTION_MS - 1 })
    expect(
      recoveryRootsPastRetention([fresh, expired, older], DEFAULT_RECOVERY_RETENTION_MS, now)
        .map(s => s.id),
    ).toEqual(['expired', 'older'])
  })

  it('disables automatic purge when retentionMs is 0 or negative', () => {
    const expired = root({ id: 'expired', deletedAt: 0 })
    expect(recoveryRootsPastRetention([expired], 0, now)).toEqual([])
    expect(recoveryRootsPastRetention([expired], -1, now)).toEqual([])
  })

  it('skips roots that lack a usable deleted.at stamp', () => {
    const missing = root({ id: 'missing' })
    expect(recoveryRootsPastRetention([missing], DEFAULT_RECOVERY_RETENTION_MS, now)).toEqual([])
  })
})
