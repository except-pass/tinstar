// @vitest-environment node
//
// The crash-safe Surface sidecar (U1). Every crash in here is simulated by
// manipulating files directly or by throwing from a NAMED step of the write
// sequence — never by racing a timer — so the suite is deterministic.
//
// The U1 scenarios this file owns:
//   · a primary snapshot interrupted before replacement leaves the prior primary
//     readable;
//   · a corrupt primary loads the valid backup and reports recovery;
//   · corrupt primary AND backup enter faulted-read-only before rehydration and
//     cannot be overwritten by later startup work;
//   · persistence failure before commit leaves memory, SSE, and response state
//     unchanged;
//   · a crash after durable commit but before SSE reloads the new topology on
//     restart;
//   · a crash after SSE but before response returns the persisted idempotent
//     result on retry;
//   · a canonical snapshot reload reconstructs parent indexes and topology
//     revision exactly (the DISK half — the pure rebuild is in surfaces.test.ts);
//   · a second backend against the same config root is refused before it can open
//     the sidecar, through the existing singleton guard.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SURFACE_SIDECAR_SCHEMA_VERSION,
  SurfaceSidecar,
  hydrateFreshnessEvidence,
  nodeSidecarIo,
  surfaceSidecarPaths,
  type SidecarIo,
  type SidecarWriteStep,
  type SurfaceSidecarPaths,
} from '../surface-persistence'
import { SurfaceStore, homeKey } from '../surfaces'
import { acquireBackendSingleton, backendSingletonOwner } from '../../infra/lock'
import type { Surface, SurfaceHome } from '../../../domain/types'

const SPACE = 'space-1'
const CANVAS: SurfaceHome = { kind: 'canvas', spaceId: SPACE }

interface Ctx {
  dir: string
  lockPath: string
  paths: SurfaceSidecarPaths
  /** Open a sidecar against this dir — the "restart" of every crash scenario. */
  open: (hooks?: { beforeStep?: (s: SidecarWriteStep) => void | Promise<void> }) => SurfaceSidecar
}

/**
 * Run a body against a throwaway config root with the backend singleton REALLY
 * held by this process. Held for real rather than stubbed because the sidecar's
 * assertion is one of the behaviours under test: a fake would let the assertion
 * rot without a single test noticing.
 */
async function withConfigRoot(body: (ctx: Ctx) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'surface-sidecar-'))
  const lockPath = join(dir, 'server.lock')
  const lock = acquireBackendSingleton(lockPath)
  if (!lock.acquired) throw new Error('test setup could not acquire the backend singleton')
  try {
    await body({
      dir,
      lockPath,
      paths: surfaceSidecarPaths(dir),
      open: hooks => SurfaceSidecar.open({ dir, lockPath, ...(hooks ? { hooks } : {}) }),
    })
  } finally {
    // The marker outlives only its owner; standalone.ts drops it the same way.
    rmSync(`${lockPath}.mark`, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A minimal but COMPLETE canonical record — every field the shape guard and the
 *  topology rebuild read is populated, so a test never passes because a guard
 *  skipped a half-built object. */
function rec(id: string, over: Partial<Surface> = {}): Surface {
  return {
    id,
    spaceId: SPACE,
    home: CANVAS,
    content: { headline: id },
    contentAuthority: 'canonical-direct',
    author: 'agent',
    thread: { replies: [], status: 'open' },
    freshness: { phase: 'current', overdue: false },
    rev: 1,
    homeRev: 1,
    createdAt: 1_000,
    amendedAt: 1_000,
    ...over,
  }
}

function readPrimary(paths: SurfaceSidecarPaths): { version: number; records: Surface[] } {
  return JSON.parse(readFileSync(paths.primary, 'utf-8'))
}

function idsOf(records: Surface[]): string[] {
  return records.map(r => r.id).sort()
}

/** A pass-through io that logs every durability-relevant call, resolving each fd
 *  back to the path it was opened on so an fsync is attributable to a file. */
function recordingIo(): { io: SidecarIo; log: string[] } {
  const log: string[] = []
  const paths = new Map<number, string>()
  const io: SidecarIo = {
    open: (path, flags) => {
      const fd = nodeSidecarIo.open(path, flags)
      paths.set(fd, path)
      return fd
    },
    writeString: (fd, data) => { log.push(`write ${paths.get(fd)}`); nodeSidecarIo.writeString(fd, data) },
    writeBuffer: (fd, data) => { log.push(`write ${paths.get(fd)}`); nodeSidecarIo.writeBuffer(fd, data) },
    fsync: fd => { log.push(`fsync ${paths.get(fd)}`); nodeSidecarIo.fsync(fd) },
    close: fd => { nodeSidecarIo.close(fd); paths.delete(fd) },
    rename: (from, to) => { log.push(`rename ${from} -> ${to}`); nodeSidecarIo.rename(from, to) },
    readFile: path => nodeSidecarIo.readFile(path),
    exists: path => nodeSidecarIo.exists(path),
  }
  return { io, log }
}

/** Throw from exactly one step of the write sequence. */
function crashAt(target: SidecarWriteStep) {
  return { beforeStep: (s: SidecarWriteStep) => { if (s === target) throw new Error(`simulated crash at ${target}`) } }
}

describe('sidecar layout', () => {
  it('lives beside docstore.json under the config root without sharing its file', async () => {
    await withConfigRoot(async ({ dir, paths, open }) => {
      expect(paths.primary).toBe(join(dir, 'surfaces.json'))
      expect(paths.backup).toBe(join(dir, 'surfaces.backup.json'))
      // The temp file must be in the same directory — a cross-device rename is a
      // copy, and a copy is not atomic.
      expect(paths.temp.startsWith(dir)).toBe(true)

      // A pre-existing core document snapshot must survive a Surface commit
      // byte-for-byte: the two stores may never replace each other's snapshots.
      const docstore = join(dir, 'docstore.json')
      writeFileSync(docstore, JSON.stringify({ runs: [{ id: 'r1' }] }))
      const before = readFileSync(docstore, 'utf-8')

      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })

      expect(readFileSync(docstore, 'utf-8')).toBe(before)
      expect(existsSync(paths.primary)).toBe(true)
    })
  })

  it('persists only the declared, schema-versioned sections', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')], idempotencyKey: 'k1', result: { ok: true } })
      const parsed = JSON.parse(readFileSync(paths.primary, 'utf-8'))
      expect(Object.keys(parsed).sort()).toEqual(['idempotency', 'records', 'topologyRevs', 'version'])
      expect(parsed.version).toBe(SURFACE_SIDECAR_SCHEMA_VERSION)
    })
  })

  it('starts healthy and empty on a first boot with nothing on disk', async () => {
    await withConfigRoot(({ paths, open }) => {
      const sc = open()
      expect(sc.health).toBe('healthy')
      expect(sc.outcome.from).toBe('empty')
      expect(sc.outcome.records).toEqual([])
      expect(sc.fault).toBeUndefined()
      // Opening must not create anything — a read of an empty store is a read.
      expect(existsSync(paths.primary)).toBe(false)
      expect(existsSync(paths.backup)).toBe(false)
    })
  })
})

describe('the atomic write sequence', () => {
  it('runs the five steps in the order KTD5 specifies', async () => {
    await withConfigRoot(async ({ open }) => {
      const steps: SidecarWriteStep[] = []
      const sc = open({ beforeStep: s => { steps.push(s) } })
      await sc.commit({ puts: [rec('sf-a')] })
      await sc.commit({ puts: [rec('sf-b')] })
      // First write has no known-good primary to rotate, but the step still runs
      // in place so the ORDER is one sequence, not two shapes.
      expect(steps.slice(0, 5)).toEqual(['write-temp', 'fsync-temp', 'rotate-backup', 'rename-primary', 'fsync-dir'])
      expect(steps.slice(5)).toEqual(['write-temp', 'fsync-temp', 'rotate-backup', 'rename-primary', 'fsync-dir'])
    })
  })

  // The step list above proves each step was ANNOUNCED. These prove the two
  // durability syscalls actually happened — they have no in-process observable
  // effect, and `node:fs` named imports cannot be spied on under vitest, which is
  // why the sidecar takes an injectable io.
  it('fsyncs the temp file BEFORE the rename and the directory AFTER it', async () => {
    await withConfigRoot(async ({ dir, lockPath, paths }) => {
      const { io, log } = recordingIo()
      const sc = SurfaceSidecar.open({ dir, lockPath, io })
      await sc.commit({ puts: [rec('sf-a')] })

      const fsyncedTemp = log.indexOf(`fsync ${paths.temp}`)
      const renamed = log.indexOf(`rename ${paths.temp} -> ${paths.primary}`)
      const fsyncedDir = log.indexOf(`fsync ${dir}`)
      expect(fsyncedTemp).toBeGreaterThanOrEqual(0)
      expect(renamed).toBeGreaterThan(fsyncedTemp)
      expect(fsyncedDir).toBeGreaterThan(renamed)
    })
  })

  it('fsyncs the rotated backup before it replaces the previous one', async () => {
    await withConfigRoot(async ({ dir, lockPath, paths }) => {
      const seed = SurfaceSidecar.open({ dir, lockPath })
      await seed.commit({ puts: [rec('sf-a')] })

      const { io, log } = recordingIo()
      const sc = SurfaceSidecar.open({ dir, lockPath, io })
      await sc.commit({ puts: [rec('sf-b')] })

      const fsynced = log.indexOf(`fsync ${paths.backupTemp}`)
      const renamed = log.indexOf(`rename ${paths.backupTemp} -> ${paths.backup}`)
      expect(fsynced).toBeGreaterThanOrEqual(0)
      expect(renamed).toBeGreaterThan(fsynced)
    })
  })

  it('leaves the prior primary readable when interrupted before replacement', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const first = open()
      await first.commit({ puts: [rec('sf-a')] })
      const priorBytes = readFileSync(paths.primary, 'utf-8')

      const sc = open(crashAt('rename-primary'))
      const onDurable = vi.fn()
      const res = await sc.commit({ puts: [rec('sf-b')], onDurable })

      expect(res).toMatchObject({ committed: false, reason: 'write-failed' })
      expect(onDurable).not.toHaveBeenCalled()
      // The bytes on disk are the PRIOR snapshot, unchanged.
      expect(readFileSync(paths.primary, 'utf-8')).toBe(priorBytes)
      // And the durable record set never advanced.
      expect(idsOf(sc.durableRecords())).toEqual(['sf-a'])

      const restarted = open()
      expect(restarted.health).toBe('healthy')
      expect(idsOf(restarted.outcome.records)).toEqual(['sf-a'])
    })
  })

  it('leaves memory and the response path untouched when the write fails before commit', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const seed = open()
      await seed.commit({ puts: [rec('sf-a')] })
      const priorBytes = readFileSync(paths.primary, 'utf-8')

      // A crash at the very first step: nothing has been written at all.
      const sc = open(crashAt('write-temp'))
      const onDurable = vi.fn()
      const res = await sc.commit({ puts: [rec('sf-b')], idempotencyKey: 'k-lost', result: 'r', onDurable })

      expect(res).toMatchObject({ committed: false, reason: 'write-failed' })
      expect(onDurable).not.toHaveBeenCalled()
      expect(idsOf(sc.durableRecords())).toEqual(['sf-a'])
      expect(readFileSync(paths.primary, 'utf-8')).toBe(priorBytes)

      // No receipt was persisted either: a retry of a transaction that never
      // committed must re-run, not replay a result that was never produced.
      const restarted = open()
      const retry = await restarted.commit({ puts: [rec('sf-b')], idempotencyKey: 'k-lost', result: 'r' })
      expect(retry).toMatchObject({ committed: true, replayed: false })
    })
  })

  it('skips the write when the candidate is byte-identical to what is on disk', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      const a = rec('sf-a')
      await sc.commit({ puts: [a] })
      const bytes = readFileSync(paths.primary, 'utf-8')

      const again = await sc.commit({ puts: [{ ...a, rev: 2 }] })
      expect(again).toMatchObject({ committed: true, wrote: true })

      // Re-putting the exact stored record is rejected as stale, so the no-op path
      // is reached through a transaction that changes nothing at all.
      const noop = await sc.commit({})
      expect(noop).toMatchObject({ committed: true, wrote: false })
      expect(readFileSync(paths.primary, 'utf-8')).not.toBe(bytes) // rev 2 landed
      const after = readFileSync(paths.primary, 'utf-8')
      await sc.commit({})
      expect(readFileSync(paths.primary, 'utf-8')).toBe(after)
    })
  })
})

describe('recovery from a corrupt primary', () => {
  it('loads the valid backup and reports recovery', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })
      await sc.commit({ puts: [rec('sf-b')] })
      // Rotation put the sf-a-only snapshot in the backup slot.
      expect(idsOf(JSON.parse(readFileSync(paths.backup, 'utf-8')).records)).toEqual(['sf-a'])

      writeFileSync(paths.primary, '{"version":1,"records":[{"id":"sf-a"') // torn write

      const restarted = open()
      expect(restarted.health).toBe('recovered')
      expect(restarted.outcome.from).toBe('backup')
      expect(idsOf(restarted.outcome.records)).toEqual(['sf-a'])
      expect(restarted.fault).toBeUndefined()
    })
  })

  it('recovers from a missing primary with a valid backup (crash mid-rotation)', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })
      await sc.commit({ puts: [rec('sf-b')] })
      rmSync(paths.primary)

      const restarted = open()
      expect(restarted.health).toBe('recovered')
      expect(idsOf(restarted.outcome.records)).toEqual(['sf-a'])
    })
  })

  it('does not rotate a KNOWN-BAD primary over the good backup on the next write', async () => {
    // The failure this guards: rotation copies the current primary into the backup
    // slot, so a naive first write after a recovery would overwrite the only
    // readable snapshot with the corrupt bytes we just recovered FROM.
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })
      await sc.commit({ puts: [rec('sf-b')] })
      writeFileSync(paths.primary, 'not json at all')

      const recovered = open()
      expect(recovered.health).toBe('recovered')
      const res = await recovered.commit({ puts: [rec('sf-c')] })
      expect(res).toMatchObject({ committed: true, wrote: true })

      // Backup untouched: still the last known good, never the corrupt bytes.
      const backup = JSON.parse(readFileSync(paths.backup, 'utf-8'))
      expect(idsOf(backup.records)).toEqual(['sf-a'])
      // Primary repaired with the recovered state plus the new record.
      expect(idsOf(readPrimary(paths).records)).toEqual(['sf-a', 'sf-c'])

      const again = open()
      expect(again.health).toBe('healthy')
      expect(idsOf(again.outcome.records)).toEqual(['sf-a', 'sf-c'])
    })
  })

  it('quarantines individual damaged records rather than condemning the file', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      writeFileSync(paths.primary, JSON.stringify({
        version: SURFACE_SIDECAR_SCHEMA_VERSION,
        records: [rec('sf-a'), { id: 'sf-broken' }, { ...rec('sf-c'), rev: null }],
        idempotency: [],
      }))
      const sc = open()
      expect(sc.health).toBe('healthy')
      expect(idsOf(sc.outcome.records)).toEqual(['sf-a'])
      expect(sc.outcome.quarantined).toBe(2)
    })
  })
})

describe('faulted-read-only', () => {
  /** Corrupt both files and return their exact bytes, for a byte-untouched check. */
  function poison(paths: SurfaceSidecarPaths): { primary: string; backup: string } {
    const primary = '{"version":1,"records":[{"id":'
    const backup = 'garbage bytes, not even json'
    writeFileSync(paths.primary, primary)
    writeFileSync(paths.backup, backup)
    return { primary, backup }
  }

  it('faults before rehydration, exposes the fault, and rejects every mutation', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const bytes = poison(paths)
      const sc = open()

      // The outcome is available synchronously from `open`, which is what puts it
      // in the caller's hands BEFORE any session rehydration could be scheduled.
      expect(sc.health).toBe('faulted-read-only')
      expect(sc.outcome.records).toEqual([])
      expect(sc.fault?.primary.kind).toBe('unparsable')
      expect(sc.fault?.backup.kind).toBe('unparsable')

      const onDurable = vi.fn()
      const res = await sc.commit({ puts: [rec('sf-a')], idempotencyKey: 'k', onDurable })
      expect(res).toEqual({ committed: false, reason: 'faulted-read-only' })
      expect(onDurable).not.toHaveBeenCalled()

      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes.primary)
      expect(readFileSync(paths.backup, 'utf-8')).toBe(bytes.backup)
    })
  })

  it('cannot be overwritten by later startup work, and stays faulted across restarts', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const bytes = poison(paths)
      const sc = open()

      // Whatever boot does next — migration, cascade cleanup, a burst of
      // rehydration writes — none of it may reach the disk.
      for (let i = 0; i < 5; i++) {
        expect(await sc.commit({ puts: [rec(`sf-${i}`)] })).toMatchObject({ reason: 'faulted-read-only' })
      }
      expect(await sc.commit({ drops: ['sf-a'] })).toMatchObject({ reason: 'faulted-read-only' })
      expect(await sc.commit({})).toMatchObject({ reason: 'faulted-read-only' })
      expect(sc.durableRecords()).toEqual([])
      expect(existsSync(paths.temp)).toBe(false)

      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes.primary)
      expect(readFileSync(paths.backup, 'utf-8')).toBe(bytes.backup)

      // Evidence survives a restart too — a faulted store never repairs itself by
      // truncation.
      const restarted = open()
      expect(restarted.health).toBe('faulted-read-only')
      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes.primary)
      expect(readFileSync(paths.backup, 'utf-8')).toBe(bytes.backup)
    })
  })

  it('faults on a corrupt primary with no backup at all', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      writeFileSync(paths.primary, '}{')
      const sc = open()
      expect(sc.health).toBe('faulted-read-only')
      expect(sc.fault?.backup.kind).toBe('missing')
      expect(readFileSync(paths.primary, 'utf-8')).toBe('}{')
    })
  })

  it('faults rather than guessing at a snapshot written by a different schema', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const future = JSON.stringify({ version: SURFACE_SIDECAR_SCHEMA_VERSION + 1, records: [rec('sf-a')] })
      writeFileSync(paths.primary, future)
      const sc = open()
      expect(sc.health).toBe('faulted-read-only')
      expect(sc.fault?.primary.kind).toBe('unknown-version')
      expect(readFileSync(paths.primary, 'utf-8')).toBe(future)
    })
  })
})

describe('crash between durable commit and acknowledgement', () => {
  it('reloads the new topology when the process dies after commit but before SSE', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })

      // `onDurable` is the install-and-emit half of the KTD7 ordering; throwing
      // from it is a crash in exactly that window.
      await expect(
        sc.commit({ puts: [rec('sf-b')], onDurable: () => { throw new Error('died before SSE') } }),
      ).rejects.toThrow('died before SSE')

      const restarted = open()
      expect(restarted.health).toBe('healthy')
      expect(idsOf(restarted.outcome.records)).toEqual(['sf-a', 'sf-b'])

      // A rejected transaction must not poison the queue for the next one.
      expect(await sc.commit({ puts: [rec('sf-c')] })).toMatchObject({ committed: true })
    })
  })

  it('returns the persisted idempotent result on retry after a lost response', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      const emitted = vi.fn()
      const first = await sc.commit({
        puts: [rec('sf-a', { rev: 3 })],
        idempotencyKey: 'intent-42',
        result: { batch: 'b-1', applied: ['sf-a'] },
        onDurable: emitted,
      })
      expect(first).toMatchObject({ committed: true, replayed: false })
      expect(emitted).toHaveBeenCalledTimes(1)

      // The response was lost; the process restarted; the caller retries.
      const restarted = open()
      const replayEmit = vi.fn()
      const retry = await restarted.commit({
        puts: [rec('sf-a', { rev: 4 })],
        idempotencyKey: 'intent-42',
        result: { batch: 'b-2', applied: [] },
        onDurable: replayEmit,
      })

      expect(retry).toMatchObject({ committed: true, replayed: true, wrote: false })
      // The PERSISTED result, not the retry's.
      expect(retry.committed && retry.result).toEqual({ batch: 'b-1', applied: ['sf-a'] })
      // And nothing was re-applied: no second emit, and the record still holds the
      // revision the original transaction wrote.
      expect(replayEmit).not.toHaveBeenCalled()
      expect(restarted.durableRecords()[0]!.rev).toBe(3)
    })
  })

  it('replays within the same process too, without a restart', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')], idempotencyKey: 'k', result: 'first' })
      const retry = await sc.commit({ puts: [rec('sf-a', { rev: 9 })], idempotencyKey: 'k', result: 'second' })
      expect(retry).toMatchObject({ committed: true, replayed: true })
      expect(retry.committed && retry.result).toBe('first')
      expect(sc.durableRecords()[0]!.rev).toBe(1)
    })
  })
})

describe('the serialized transaction queue', () => {
  it('does not interleave concurrent commits', async () => {
    await withConfigRoot(async ({ open }) => {
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      let holdOnce = true
      const order: string[] = []

      const sc = open({
        beforeStep: async step => {
          order.push(step)
          if (step === 'fsync-temp' && holdOnce) {
            holdOnce = false
            await held // first transaction parks mid-write
          }
        },
      })

      const a = sc.commit({ puts: [rec('sf-a')] })
      const b = sc.commit({ puts: [rec('sf-b')] })
      // Drain the microtask queue: A is parked on `held`, so whatever the runtime
      // was going to schedule has been scheduled by the time this resolves.
      await new Promise(resolve => setImmediate(resolve))
      // B must not have started any step while A is parked.
      expect(order).toEqual(['write-temp', 'fsync-temp'])

      release()
      expect(await a).toMatchObject({ committed: true })
      expect(await b).toMatchObject({ committed: true })

      // Two complete sequences, back to back — never interleaved.
      expect(order).toEqual([
        'write-temp', 'fsync-temp', 'rotate-backup', 'rename-primary', 'fsync-dir',
        'write-temp', 'fsync-temp', 'rotate-backup', 'rename-primary', 'fsync-dir',
      ])
      // B built its candidate on A's committed base rather than on a stale one.
      expect(idsOf(sc.durableRecords())).toEqual(['sf-a', 'sf-b'])
    })
  })
})

describe('revision-checked transactions', () => {
  it('refuses a put that is not newer than the persisted record', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a', { rev: 5 })] })
      const bytes = readFileSync(paths.primary, 'utf-8')

      expect(await sc.commit({ puts: [rec('sf-a', { rev: 5 })] })).toMatchObject({ committed: false, reason: 'stale-revision' })
      expect(await sc.commit({ puts: [rec('sf-a', { rev: 4 })] })).toMatchObject({ committed: false, reason: 'stale-revision' })
      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes)
    })
  })

  it('compares expected revisions against the DURABLE record, absent counting as 0', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      expect(await sc.commit({ puts: [rec('sf-a')], expectedRevs: { 'sf-a': 0 } })).toMatchObject({ committed: true })
      expect(await sc.commit({ puts: [rec('sf-a', { rev: 2 })], expectedRevs: { 'sf-a': 7 } }))
        .toMatchObject({ committed: false, reason: 'stale-revision' })
      expect(await sc.commit({ puts: [rec('sf-a', { rev: 2 })], expectedRevs: { 'sf-a': 1 } }))
        .toMatchObject({ committed: true })
    })
  })

  it('refuses a drop of a record that is not persisted', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })
      expect(await sc.commit({ drops: ['sf-ghost'] })).toMatchObject({ committed: false, reason: 'unknown-record' })
      expect(await sc.commit({ drops: ['sf-a'] })).toMatchObject({ committed: true })
      expect(sc.durableRecords()).toEqual([])
    })
  })

  it('rejects a record that would not survive its own serialization, before touching a file', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })
      const bytes = readFileSync(paths.primary, 'utf-8')

      // NaN is the sharp case: JSON turns it into `null`, so a record carrying one
      // would come back UNUSABLE on the next boot — long after this commit was
      // acknowledged as successful.
      expect(await sc.commit({ puts: [rec('sf-b', { rev: NaN })] }))
        .toMatchObject({ committed: false, reason: 'invalid-record' })
      expect(await sc.commit({ puts: [{ ...rec('sf-c'), home: undefined } as unknown as Surface] }))
        .toMatchObject({ committed: false, reason: 'invalid-record' })

      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes)
      expect(idsOf(sc.durableRecords())).toEqual(['sf-a'])
    })
  })

  it('validates the BYTES of the candidate, not just the object', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('sf-a')] })
      const bytes = readFileSync(paths.primary, 'utf-8')

      // A record that inspects as valid but serializes to something that would
      // reload as UNUSABLE. Exotic, and that is the point: "validate a complete
      // temporary snapshot" has to mean the snapshot that will be on disk, or the
      // damage only surfaces on the next boot — long after this commit was
      // acknowledged as successful.
      const lying = Object.assign(rec('sf-lies'), { toJSON: () => ({ id: 'sf-lies' }) })
      expect(await sc.commit({ puts: [lying] })).toMatchObject({ committed: false, reason: 'invalid-record' })

      // And a record that cannot be serialized at all.
      const circular = rec('sf-loop') as Surface & { self?: unknown }
      circular.self = circular
      expect(await sc.commit({ puts: [circular] })).toMatchObject({ committed: false, reason: 'invalid-record' })

      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes)
      expect(idsOf(sc.durableRecords())).toEqual(['sf-a'])
    })
  })
})

describe('snapshot reload', () => {
  it('reconstructs parent indexes and topology revision exactly from disk', async () => {
    await withConfigRoot(async ({ open }) => {
      // Build a real tree through the store, so the persisted records are the ones
      // its own mutators produce rather than hand-written approximations.
      const live = new SurfaceStore(() => {})
      const mk = (headline: string, home: SurfaceHome = CANVAS) => {
        const r = live.createSurface({ spaceId: SPACE, home, content: { headline } }, { at: 1_000 })
        if (!r.applied) throw new Error(`setup create rejected: ${r.reason}`)
        return r.surfaces[0]!
      }
      const a = mk('a')
      const b = mk('b')
      const child = mk('child', { kind: 'surface', surfaceId: a.id })
      const grouped = live.group([a.id, b.id], { content: { headline: 'box' } }, { at: 2_000 })
      if (!grouped.applied) throw new Error(`setup group rejected: ${grouped.reason}`)
      const liveRev = live.getTopologyRev(SPACE)
      expect(liveRev).toBeGreaterThan(1)

      const sc = open()
      const res = await sc.commit({ puts: live.getAllSurfaces() })
      expect(res).toMatchObject({ committed: true })

      // Restart: a flat record list off disk must reproduce the derived state.
      const restarted = open()
      expect(restarted.health).toBe('healthy')
      const rebuilt = new SurfaceStore(() => {})
      rebuilt.load(restarted.outcome.records)

      expect(rebuilt.getTopologyRev(SPACE)).toBe(liveRev)
      expect(idsOf(rebuilt.getAllSurfaces())).toEqual(idsOf(live.getAllSurfaces()))
      for (const s of live.getAllSurfaces()) {
        expect(rebuilt.getSurface(s.id)).toEqual(s)
        expect(rebuilt.getChildren(s.id).map(c => c.id)).toEqual(live.getChildren(s.id).map(c => c.id))
        expect(rebuilt.getAncestors(s.id).map(c => c.id)).toEqual(live.getAncestors(s.id).map(c => c.id))
      }
      expect(rebuilt.getRoots(SPACE).map(s => s.id)).toEqual(live.getRoots(SPACE).map(s => s.id))
      // The home key a child indexes under survives verbatim — the index is keyed
      // by it, so a reload that changed it would silently orphan the subtree.
      expect(homeKey(rebuilt.getSurface(child.id)!.home)).toBe(homeKey(live.getSurface(child.id)!.home))
    })
  })

  it('carries the topology counter across a restart, above the floor the records imply', async () => {
    await withConfigRoot(async ({ open }) => {
      const a: Surface = rec('a')
      const sc = open()
      // A counter well ahead of any record's `homeRev` — which is the state a
      // purge leaves behind, since a purge advances the revision and erases the
      // records that held the high-water mark.
      expect(await sc.commit({ puts: [a], topologyRevs: { [SPACE]: 9 } })).toMatchObject({ committed: true })

      const restarted = open()
      expect(restarted.outcome.topologyRevs).toEqual({ [SPACE]: 9 })
      const rebuilt = new SurfaceStore(() => {})
      rebuilt.load(restarted.outcome.records, restarted.outcome.topologyRevs)
      // Not 1 (the floor `max(homeRev)` implies). A restart that dropped back to
      // the floor would hand a client a revision it had already moved past.
      expect(rebuilt.getTopologyRev(SPACE)).toBe(9)
    })
  })

  it('never lowers a persisted counter, whatever a transaction asks for', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('a')], topologyRevs: { [SPACE]: 5 } })
      await sc.commit({ puts: [{ ...rec('b'), rev: 1 }], topologyRevs: { [SPACE]: 2 } })
      expect(open().outcome.topologyRevs).toEqual({ [SPACE]: 5 })
    })
  })

  it('reads a pre-U3 snapshot, which has no counter at all, without faulting', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      // Exactly what U1/U1e wrote. Adding the counter is deliberately NOT a schema
      // version bump: treating an older file as an unknown version would fault a
      // real install into read-only over a field it predates.
      writeFileSync(paths.primary, JSON.stringify({
        version: SURFACE_SIDECAR_SCHEMA_VERSION,
        records: [rec('a')],
        idempotency: [],
      }))
      const sc = open()
      expect(sc.health).toBe('healthy')
      expect(sc.outcome.topologyRevs).toEqual({})
      expect(sc.outcome.records).toHaveLength(1)
    })
  })
})

describe('the pre-commit re-validation hook', () => {
  it('refuses inside the queue, before any file is touched', async () => {
    await withConfigRoot(async ({ paths, open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('a')] })
      const before = readFileSync(paths.primary, 'utf-8')

      const res = await sc.commit({
        puts: [{ ...rec('a'), rev: 2, content: { headline: 'changed' } }],
        precommit: () => ({ ok: false, reason: 'stale-topology-revision' }),
      })
      expect(res).toEqual({ committed: false, reason: 'precommit-refused', detail: 'stale-topology-revision' })
      // Nothing written, nothing installed — the same "failure before durable
      // commit changes nothing" guarantee every other rejection gives.
      expect(readFileSync(paths.primary, 'utf-8')).toBe(before)
      expect(sc.durableRecords()[0]!.content.headline).toBe('a')
    })
  })

  it('persists the records the hook substituted, not the ones it was handed', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      // How a caller allocates the topology revision at COMMIT time: it re-plans
      // inside the queue and hands back the recomputed records.
      const res = await sc.commit({
        puts: [{ ...rec('a'), homeRev: 1 }],
        precommit: () => ({
          ok: true,
          puts: [{ ...rec('a'), homeRev: 7 }],
          topologyRevs: { [SPACE]: 7 },
          result: { allocated: 7 },
        }),
      })
      expect(res).toMatchObject({ committed: true, result: { allocated: 7 } })
      expect(sc.durableRecords()[0]!.homeRev).toBe(7)
      expect(open().outcome.topologyRevs).toEqual({ [SPACE]: 7 })
    })
  })

  it('is not run on a replayed retry, because a replay applies nothing', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      await sc.commit({ puts: [rec('a')], idempotencyKey: 'k' })
      const precommit = vi.fn(() => ({ ok: true as const }))
      const replay = await sc.commit({ puts: [rec('a')], idempotencyKey: 'k', precommit })
      expect(replay).toMatchObject({ committed: true, replayed: true })
      expect(precommit).not.toHaveBeenCalled()
    })
  })
})

describe('the recovery-store home is a first-class persisted shape (KTD15)', () => {
  // U3 turns deletion into a MOVE: the root of a deleted subtree is an ordinary
  // record whose `home.kind` is `recovery`. The shape guard originally knew only
  // `canvas` and `surface`, which made this the worst kind of bug — deletion
  // worked perfectly in memory and was refused at the durable boundary, and any
  // recovery record that HAD reached disk would have been quarantined away on the
  // next boot, erasing the only copy of the work the recovery store exists to
  // keep. Both halves are pinned below.

  it('accepts a recovery-homed record on commit', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      const deleted = rec('sf-deleted', {
        home: { kind: 'recovery', spaceId: SPACE },
        deleted: { at: 5_000, formerHome: CANVAS, disposition: 'delete-subtree' },
      })
      const res = await sc.commit({ puts: [deleted] })
      expect(res).toMatchObject({ committed: true })
      expect(idsOf(sc.durableRecords())).toEqual(['sf-deleted'])
    })
  })

  it('loads a recovery-homed record back rather than quarantining it', async () => {
    await withConfigRoot(async ({ open, paths }) => {
      const sc = open()
      await sc.commit({
        puts: [
          rec('sf-live'),
          rec('sf-deleted', {
            home: { kind: 'recovery', spaceId: SPACE },
            deleted: { at: 5_000, formerHome: CANVAS, disposition: 'reparent-children' },
          }),
        ],
      })
      expect(readPrimary(paths).records).toHaveLength(2)

      const restarted = open()
      expect(restarted.outcome.quarantined).toBe(0)
      expect(idsOf(restarted.outcome.records)).toEqual(['sf-deleted', 'sf-live'])
      expect(restarted.outcome.records.find(r => r.id === 'sf-deleted')!.deleted?.formerHome).toEqual(CANVAS)
    })
  })

  it('still refuses a home kind that is not one of the three', async () => {
    await withConfigRoot(async ({ open }) => {
      const sc = open()
      const bogus = rec('sf-bogus', { home: { kind: 'graveyard', spaceId: SPACE } as unknown as SurfaceHome })
      expect(await sc.commit({ puts: [bogus] })).toMatchObject({ committed: false, reason: 'invalid-record' })
    })
  })
})

describe('the backend singleton assertion', () => {
  /** A throwaway config root with NO singleton acquired. */
  function withUnguardedRoot(body: (dir: string, lockPath: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'surface-sidecar-unguarded-'))
    try { body(dir, join(dir, 'server.lock')) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('refuses to open when the singleton is not held at all', () => {
    withUnguardedRoot((dir, lockPath) => {
      expect(() => SurfaceSidecar.open({ dir, lockPath })).toThrow(/backend singleton .* is not held/)
      expect(existsSync(surfaceSidecarPaths(dir).primary)).toBe(false)
    })
  })

  it('refuses a second backend on the same config root, before it can open the sidecar', () => {
    withUnguardedRoot((dir, lockPath) => {
      const paths = surfaceSidecarPaths(dir)
      writeFileSync(paths.primary, JSON.stringify({
        version: SURFACE_SIDECAR_SCHEMA_VERSION, records: [rec('sf-a')], idempotency: [],
      }))
      const bytes = readFileSync(paths.primary, 'utf-8')

      // Fabricate a marker owned by a LIVE process that is not us. `process.ppid`
      // is the vitest parent: alive for the duration of the run, and deterministic
      // in a way spawning a sleeper is not. The layout is lock.ts's, so the
      // `backendSingletonOwner` assertion below fails loudly if that ever changes
      // — otherwise a stale fake would send this test down the "not held at all"
      // branch and pass for the wrong reason.
      mkdirSync(`${lockPath}.mark`, { recursive: true })
      writeFileSync(join(`${lockPath}.mark`, 'owner.json'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
      expect(backendSingletonOwner(lockPath)).toBe(process.ppid)

      expect(() => SurfaceSidecar.open({ dir, lockPath })).toThrow(
        new RegExp(`another tinstar backend is already running .*pid ${process.ppid}`),
      )
      // The other backend's sidecar was not read, written, rotated, or truncated.
      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes)
      expect(existsSync(paths.backup)).toBe(false)
      expect(existsSync(paths.temp)).toBe(false)
    })
  })

  it('opens when this process holds the singleton', async () => {
    await withConfigRoot(({ open }) => {
      expect(() => open()).not.toThrow()
    })
  })
})

describe('freshness evidence is guaranteed on every persisted record (R3, KTD5/KTD11)', () => {
  /** A record written before the evidence fields existed. */
  function legacyRecord(over: Partial<Surface> = {}): Surface {
    return {
      id: 'sf-legacy',
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'Coverage 88%' },
      contentAuthority: 'canonical-direct',
      author: 'agent',
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false, verifiedAt: 7_000 },
      rev: 3,
      homeRev: 1,
      createdAt: 1_000,
      amendedAt: 8_000,
      ...over,
    } as Surface
  }

  it('backfills lastKnownAt from the best evidence the record already carries', () => {
    // In decreasing order of how well each field dates the CONTENT. Never from
    // `Date.now()`: a migration that stamped the boot clock would relabel month-old
    // content as having arrived at startup.
    expect(hydrateFreshnessEvidence(legacyRecord()).freshness.lastKnownAt).toBe(7_000)
    const noVerify = legacyRecord({ freshness: { phase: 'current', overdue: false } })
    expect(hydrateFreshnessEvidence(noVerify).freshness.lastKnownAt).toBe(8_000) // amendedAt
    const bare = legacyRecord({ freshness: { phase: 'current', overdue: false }, amendedAt: undefined as never })
    expect(hydrateFreshnessEvidence(bare).freshness.lastKnownAt).toBe(1_000) // createdAt
  })

  it('writes an EXPLICIT null for never-checked, not an absent key', () => {
    // An omitted key is dropped from an SSE delta, so "never checked" has to be a
    // value a client can actually receive.
    const hydrated = hydrateFreshnessEvidence(legacyRecord())
    expect(hydrated.freshness.lastCheck).toBeNull()
    expect('lastCheck' in hydrated.freshness).toBe(true)
  })

  it('is DETERMINISTIC and RE-ENTRANT across repeated boots', () => {
    // The property the plan asks for by name. Hydrating twice must produce the same
    // bytes, or every boot would report a change and burn a revision on every
    // Surface — the exact storm this work exists to end.
    const once = hydrateFreshnessEvidence(legacyRecord())
    const twice = hydrateFreshnessEvidence(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(twice).toBe(once) // already hydrated: returned untouched, not rebuilt
  })

  it('leaves a record that already carries evidence exactly as it is', () => {
    const current = legacyRecord({
      freshness: {
        phase: 'current', overdue: false, lastKnownAt: 500,
        lastCheck: {
          startedAt: 1, finishedAt: 2, execution: 'host',
          reason: 'r', targetGeneration: 0, outcome: 'succeeded',
        },
      },
    })
    expect(hydrateFreshnessEvidence(current)).toBe(current)
  })
})
