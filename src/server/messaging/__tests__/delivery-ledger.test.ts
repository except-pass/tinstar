// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBackendSingleton } from '../../infra/lock'
import {
  DELIVERY_LEDGER_SCHEMA_VERSION,
  DeliveryLedger,
  deliveryLedgerPaths,
  nodeDeliveryLedgerIo,
  type DeliveryAcceptInput,
  type DeliveryLedgerIo,
  type DeliveryLedgerPaths,
  type DeliveryLedgerWriteStep,
  type DeliveryTransitionInput,
} from '../delivery-ledger'

interface TestContext {
  dir: string
  lockPath: string
  paths: DeliveryLedgerPaths
  open: (options?: {
    ids?: string[]
    now?: () => number
    beforeStep?: (step: DeliveryLedgerWriteStep) => void | Promise<void>
    io?: DeliveryLedgerIo
    retentionMs?: number
    maxTerminalMessages?: number
    maxOutstandingDeliveries?: number
    maxHistoryEntries?: number
  }) => DeliveryLedger
}

async function withLedger(
  body: (context: TestContext) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-'))
  const lockPath = join(dir, 'server.lock')
  const lock = acquireBackendSingleton(lockPath)
  if (!lock.acquired) throw new Error('test setup could not acquire backend singleton')
  try {
    await body({
      dir,
      lockPath,
      paths: deliveryLedgerPaths(dir),
      open: (options = {}) => {
        const ids = [...(options.ids ?? ['msg-default'])]
        return DeliveryLedger.open({
          dir,
          lockPath,
          createMessageId: () => ids.shift() ?? 'msg-exhausted',
          ...(options.now ? { now: options.now } : {}),
          ...(options.beforeStep
            ? { hooks: { beforeStep: options.beforeStep } }
            : {}),
          ...(options.io ? { io: options.io } : {}),
          ...(options.retentionMs !== undefined
            ? { retentionMs: options.retentionMs }
            : {}),
          ...(options.maxTerminalMessages !== undefined
            ? { maxTerminalMessages: options.maxTerminalMessages }
            : {}),
          ...(options.maxOutstandingDeliveries !== undefined
            ? { maxOutstandingDeliveries: options.maxOutstandingDeliveries }
            : {}),
          ...(options.maxHistoryEntries !== undefined
            ? { maxHistoryEntries: options.maxHistoryEntries }
            : {}),
        })
      },
    })
  } finally {
    rmSync(`${lockPath}.mark`, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

function input(
  requestId = 'req-1',
  overrides: Partial<DeliveryAcceptInput> = {},
): DeliveryAcceptInput {
  return {
    requestId,
    sender: { sessionId: 'sender', incarnation: 'sender-incarnation' },
    destination: { subject: 'tinstar.space.init.epic.task' },
    text: 'Please inspect the lifecycle race.',
    recipients: [
      {
        providerId: 'claude',
        sessionId: 'reviewer',
        incarnation: 'reviewer-incarnation',
      },
    ],
    ...overrides,
  }
}

function recordingIo(): { io: DeliveryLedgerIo; log: string[] } {
  const log: string[] = []
  const paths = new Map<number, string>()
  const io: DeliveryLedgerIo = {
    open(path, flags) {
      const fd = nodeDeliveryLedgerIo.open(path, flags)
      paths.set(fd, path)
      return fd
    },
    writeBuffer(fd, data) {
      log.push(`write ${paths.get(fd)}`)
      return nodeDeliveryLedgerIo.writeBuffer(fd, data)
    },
    fsync(fd) {
      log.push(`fsync ${paths.get(fd)}`)
      nodeDeliveryLedgerIo.fsync(fd)
    },
    close(fd) {
      nodeDeliveryLedgerIo.close(fd)
      paths.delete(fd)
    },
    rename(from, to) {
      log.push(`rename ${from} -> ${to}`)
      nodeDeliveryLedgerIo.rename(from, to)
    },
    readFile: path => nodeDeliveryLedgerIo.readFile(path),
  }
  return { io, log }
}

describe('DeliveryLedger acceptance', () => {
  it('persists one logical message and an independent record per recipient', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-broadcast'], now: () => 1_000 })
      const accepted = await ledger.accept(input('req-broadcast', {
        recipients: [
          {
            providerId: 'codex',
            sessionId: 'agent-2',
            incarnation: 'agent-2-v1',
          },
          {
            providerId: 'claude',
            sessionId: 'agent-1',
            incarnation: 'agent-1-v3',
          },
        ],
      }))

      expect(accepted).toMatchObject({
        accepted: true,
        replayed: false,
        wrote: true,
        message: {
          id: 'msg-broadcast',
          requestId: 'req-broadcast',
          acceptedAt: '1970-01-01T00:00:01.000Z',
        },
      })
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      expect(accepted.deliveries).toHaveLength(2)
      expect(accepted.deliveries.map(delivery => delivery.id)).toEqual([
        'msg-broadcast/d/1',
        'msg-broadcast/d/2',
      ])
      expect(accepted.deliveries.map(delivery => delivery.recipient.sessionId)).toEqual([
        'agent-1',
        'agent-2',
      ])
      expect(accepted.deliveries.every(delivery =>
        delivery.messageId === 'msg-broadcast'
        && delivery.state === 'accepted'
        && delivery.attempt === 0,
      )).toBe(true)

      const snapshot = JSON.parse(readFileSync(paths.primary, 'utf8'))
      expect(Object.keys(snapshot).sort()).toEqual([
        'deliveries', 'messages', 'version',
      ])
      expect(snapshot.version).toBe(DELIVERY_LEDGER_SCHEMA_VERSION)
      expect(snapshot.messages).toHaveLength(1)
      expect(snapshot.deliveries).toHaveLength(2)
    })
  })

  it('does not resolve acceptance until the durable write sequence completes', async () => {
    await withLedger(async ({ dir, paths, open }) => {
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      let settled = false
      const steps: DeliveryLedgerWriteStep[] = []
      const ledger = open({
        ids: ['msg-durable'],
        beforeStep: async step => {
          steps.push(step)
          if (step === 'fsync-dir') await held
        },
      })

      const accepting = ledger.accept(input('req-durable'))
      void accepting.then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))

      expect(steps).toEqual([
        'write-temp',
        'fsync-temp',
        'write-backup-temp',
        'rename-primary',
        'rename-backup',
        'fsync-dir',
      ])
      expect(existsSync(paths.primary)).toBe(true)
      expect(settled).toBe(false)

      release()
      await expect(accepting).resolves.toMatchObject({ accepted: true })
      expect(settled).toBe(true)

      const { io, log } = recordingIo()
      const restarted = DeliveryLedger.open({ dir, lockPath: join(dir, 'server.lock'), io })
      await restarted.accept(input('req-next'))
      const tempFsync = log.indexOf(`fsync ${paths.temp}`)
      const backupWrite = log.indexOf(`write ${paths.backupTemp}`)
      const backupFsync = log.indexOf(`fsync ${paths.backupTemp}`)
      const backupRename = log.indexOf(
        `rename ${paths.backupTemp} -> ${paths.backup}`,
      )
      const primaryRename = log.indexOf(`rename ${paths.temp} -> ${paths.primary}`)
      const dirFsync = log.indexOf(`fsync ${dir}`)
      expect(tempFsync).toBeGreaterThanOrEqual(0)
      expect(backupWrite).toBeGreaterThan(tempFsync)
      expect(backupFsync).toBeGreaterThan(backupWrite)
      expect(primaryRename).toBeGreaterThan(backupFsync)
      expect(backupRename).toBeGreaterThan(primaryRename)
      expect(primaryRename).toBeGreaterThan(tempFsync)
      expect(dirFsync).toBeGreaterThan(backupRename)
      expect(readFileSync(paths.backup, 'utf8')).toBe(
        readFileSync(paths.primary, 'utf8'),
      )
    })
  })

  it('writes every byte when the filesystem reports partial progress', async () => {
    await withLedger(async ({ dir, lockPath, open }) => {
      let writeCalls = 0
      const io: DeliveryLedgerIo = {
        ...nodeDeliveryLedgerIo,
        writeBuffer(fd, data) {
          writeCalls++
          const chunkLength = Math.max(1, Math.floor(data.length / 2))
          return nodeDeliveryLedgerIo.writeBuffer(fd, data.subarray(0, chunkLength))
        },
      }
      const ledger = open({ ids: ['msg-partial-write'], io })
      await expect(ledger.accept(input('req-partial-write'))).resolves.toMatchObject({
        accepted: true,
        message: { id: 'msg-partial-write' },
      })
      expect(writeCalls).toBeGreaterThan(1)

      const replacement = DeliveryLedger.open({ dir, lockPath })
      expect(replacement.getMessage('msg-partial-write')).toBeDefined()
    })
  })

  it('does not acknowledge a filesystem write that makes no progress', async () => {
    await withLedger(async ({ open }) => {
      const io: DeliveryLedgerIo = {
        ...nodeDeliveryLedgerIo,
        writeBuffer: () => 0,
      }
      const ledger = open({ ids: ['msg-zero-write'], io })
      await expect(ledger.accept(input('req-zero-write'))).resolves.toMatchObject({
        accepted: false,
        reason: 'write-failed',
        detail: 'filesystem write made invalid progress: 0',
      })
      expect(ledger.getMessage('msg-zero-write')).toBeUndefined()
    })
  })

  it('does not install a candidate when backup staging fails', async () => {
    await withLedger(async ({ paths, open }) => {
      const original = open({ ids: ['msg-before-backup-failure'] })
      await original.accept(input('req-before-backup-failure'))
      const io: DeliveryLedgerIo = {
        ...nodeDeliveryLedgerIo,
        open(path, flags) {
          if (path === paths.backupTemp && flags === 'w') {
            throw new Error('backup staging failed')
          }
          return nodeDeliveryLedgerIo.open(path, flags)
        },
      }
      const replacement = open({ ids: ['msg-backup-failure'], io })
      await expect(replacement.accept(input('req-backup-failure')))
        .resolves.toMatchObject({ accepted: false, reason: 'write-failed' })
      expect(replacement.getMessage('msg-backup-failure')).toBeUndefined()

      const reopened = open()
      expect(reopened.getMessage('msg-before-backup-failure')).toBeDefined()
      expect(reopened.getMessage('msg-backup-failure')).toBeUndefined()
    })
  })

  it('does not replace the primary when backup staging cannot be synced', async () => {
    await withLedger(async ({ paths, open }) => {
      const original = open({ ids: ['msg-before-backup-fsync'] })
      await original.accept(input('req-before-backup-fsync'))
      const fdPaths = new Map<number, string>()
      const io: DeliveryLedgerIo = {
        ...nodeDeliveryLedgerIo,
        open(path, flags) {
          const fd = nodeDeliveryLedgerIo.open(path, flags)
          fdPaths.set(fd, path)
          return fd
        },
        fsync(fd) {
          if (fdPaths.get(fd) === paths.backupTemp) {
            throw new Error('backup fsync failed')
          }
          nodeDeliveryLedgerIo.fsync(fd)
        },
        close(fd) {
          nodeDeliveryLedgerIo.close(fd)
          fdPaths.delete(fd)
        },
      }
      const replacement = open({ ids: ['msg-backup-fsync'], io })
      await expect(replacement.accept(input('req-backup-fsync')))
        .resolves.toMatchObject({ accepted: false, reason: 'write-failed' })
      expect(replacement.getMessage('msg-backup-fsync')).toBeUndefined()

      const reopened = open()
      expect(reopened.getMessage('msg-before-backup-fsync')).toBeDefined()
      expect(reopened.getMessage('msg-backup-fsync')).toBeUndefined()
    })
  })

  it('freezes when backup finalization fails and heals both copies on replay', async () => {
    await withLedger(async ({ paths, open }) => {
      const original = open({ ids: ['msg-before-backup-rename'] })
      await original.accept(input('req-before-backup-rename'))
      const io: DeliveryLedgerIo = {
        ...nodeDeliveryLedgerIo,
        rename(from, to) {
          if (from === paths.backupTemp) throw new Error('backup rename failed')
          nodeDeliveryLedgerIo.rename(from, to)
        },
      }
      const uncertain = open({ ids: ['msg-backup-rename'], io })
      await expect(uncertain.accept(input('req-backup-rename')))
        .resolves.toMatchObject({ accepted: false, reason: 'write-uncertain' })
      expect(uncertain.health).toBe('write-uncertain')
      expect(uncertain.getMessage('msg-backup-rename')).toBeUndefined()

      const reopened = open()
      expect(reopened.health).toBe('recovered')
      expect(reopened.getMessage('msg-backup-rename')).toBeDefined()
      await expect(reopened.accept(input('req-backup-rename'))).resolves.toMatchObject({
        accepted: true,
        replayed: true,
        wrote: true,
        message: { id: 'msg-backup-rename' },
      })
      expect(readFileSync(paths.backup, 'utf8')).toBe(
        readFileSync(paths.primary, 'utf8'),
      )
    })
  })

  it('replays the same request identity and rejects conflicting reuse', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-stable', 'msg-unused'] })
      const first = await ledger.accept(input('req-stable'))
      const bytes = readFileSync(paths.primary, 'utf8')
      const replay = await ledger.accept(input('req-stable'))

      expect(first).toMatchObject({ accepted: true, replayed: false })
      expect(replay).toMatchObject({
        accepted: true,
        replayed: true,
        wrote: false,
        message: { id: 'msg-stable' },
      })
      expect(readFileSync(paths.primary, 'utf8')).toBe(bytes)

      await expect(ledger.accept(input('req-stable', { text: 'different work' })))
        .resolves.toMatchObject({
          accepted: false,
          reason: 'request-id-reuse',
        })
      expect(readFileSync(paths.primary, 'utf8')).toBe(bytes)
    })
  })

  it('fingerprints semantic fields independently of runtime property order', async () => {
    await withLedger(async ({ open }) => {
      const ledger = open({ ids: ['msg-canonical'] })
      await expect(ledger.accept(input('req-canonical'))).resolves.toMatchObject({
        accepted: true,
        replayed: false,
      })

      await expect(ledger.accept(input('req-canonical', {
        sender: {
          incarnation: 'sender-incarnation',
          sessionId: 'sender',
        },
        recipients: [{
          incarnation: 'reviewer-incarnation',
          sessionId: 'reviewer',
          providerId: 'claude',
        }],
      }))).resolves.toMatchObject({
        accepted: true,
        replayed: true,
        details: 'retained',
        receipt: { messageId: 'msg-canonical' },
      })
    })
  })

  it('owns acceptance intent before queued work begins', async () => {
    await withLedger(async ({ paths, open }) => {
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const atWrite = new Promise<void>(resolve => { entered = resolve })
      let holdWrite = true
      const ledger = open({
        ids: ['msg-blocking-accept', 'msg-owned-accept'],
        beforeStep: async step => {
          if (holdWrite && step === 'write-temp') {
            holdWrite = false
            entered()
            await held
          }
        },
      })
      const blocking = ledger.accept(input('req-blocking-accept'))
      await atWrite
      const mutable = Object.assign(
        input('req-owned-accept', { text: 'original intent' }),
        { providerDetail: () => 'must not persist' },
      )
      Object.assign(mutable.sender, { providerDetail: () => 'must not persist' })
      Object.assign(mutable.destination, { providerDetail: () => 'must not persist' })
      Object.assign(mutable.recipients[0]!, {
        providerDetail: () => 'must not persist',
      })
      const accepting = ledger.accept(mutable)
      mutable.text = 'mutated intent'
      mutable.sender.incarnation = 'mutated-sender'
      mutable.recipients[0]!.incarnation = 'mutated-recipient'
      release()
      await expect(blocking).resolves.toMatchObject({ accepted: true })
      const owned = await accepting
      expect(owned).toMatchObject({
        accepted: true,
        message: {
          id: 'msg-owned-accept',
          text: 'original intent',
          sender: { incarnation: 'sender-incarnation' },
        },
        deliveries: [{ recipient: { incarnation: 'reviewer-incarnation' } }],
      })
      if (!owned.accepted || owned.details !== 'retained') {
        throw new Error('expected retained owned acceptance')
      }
      expect(Object.keys(owned.message).sort()).toEqual([
        'acceptedAt', 'deliveryIds', 'destination', 'id', 'requestFingerprint',
        'requestId', 'sender', 'text',
      ])
      expect(Object.keys(owned.message.sender).sort()).toEqual([
        'incarnation', 'sessionId',
      ])
      expect(Object.keys(owned.deliveries[0]!.recipient).sort()).toEqual([
        'incarnation', 'providerId', 'sessionId',
      ])
      const persisted = JSON.parse(readFileSync(paths.primary, 'utf8'))
      expect(persisted.messages[1]).toEqual(owned.message)
      expect(persisted.deliveries[1]).toEqual(owned.deliveries[0])
    })
  })

  it('rejects duplicate recipients instead of creating ambiguous delivery records', async () => {
    await withLedger(async ({ paths, open }) => {
      const recipient = {
        providerId: 'codex',
        sessionId: 'same-name',
        incarnation: 'same-process',
      }
      const ledger = open()
      await expect(ledger.accept(input('req-duplicate', {
        recipients: [recipient, { ...recipient }],
      }))).resolves.toMatchObject({
        accepted: false,
        reason: 'invalid-request',
      })
      expect(existsSync(paths.primary)).toBe(false)
    })
  })

  it('applies explicit backpressure without revoking an accepted request replay', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({
        ids: ['msg-capacity-one', 'msg-capacity-two'],
        maxOutstandingDeliveries: 1,
      })
      const first = await ledger.accept(input('req-capacity-one'))
      if (!first.accepted || first.details !== 'retained') {
        throw new Error('expected retained first acceptance')
      }

      await expect(ledger.accept(input('req-capacity-one'))).resolves.toMatchObject({
        accepted: true,
        replayed: true,
        message: { id: 'msg-capacity-one' },
      })
      const bytes = readFileSync(paths.primary, 'utf8')
      await expect(ledger.accept(input('req-capacity-two'))).resolves.toMatchObject({
        accepted: false,
        reason: 'capacity-exceeded',
      })
      expect(readFileSync(paths.primary, 'utf8')).toBe(bytes)

      await ledger.transition({
        deliveryId: first.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next: {
          state: 'failed',
          attempt: 0,
          reason: 'recipient deleted',
          retryable: false,
        },
      })
      await expect(ledger.accept(input('req-capacity-two'))).resolves.toMatchObject({
        accepted: true,
        message: { id: 'msg-capacity-two' },
      })
    })
  })
})

describe('DeliveryLedger reload and recovery', () => {
  it('survives service replacement with message and recipient identity intact', async () => {
    await withLedger(async ({ open }) => {
      const first = open({ ids: ['msg-restart'], now: () => 2_000 })
      const accepted = await first.accept(input('req-restart'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }

      const replacement = open({ ids: ['msg-never-used'], now: () => 9_000 })
      expect(replacement.health).toBe('healthy')
      expect(replacement.getMessage('msg-restart')).toEqual({
        message: accepted.message,
        deliveries: accepted.deliveries,
      })
      expect(replacement.listRecoverable().map(delivery => delivery.id)).toEqual([
        'msg-restart/d/1',
      ])
    })
  })

  it('recovers the latest acknowledged snapshot when the primary is corrupt', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-one', 'msg-two'] })
      await ledger.accept(input('req-one'))
      await ledger.accept(input('req-two'))
      writeFileSync(paths.primary, '{"version":1,"messages":[')

      const recovered = open({ ids: ['msg-three'] })
      expect(recovered.health).toBe('recovered')
      expect(recovered.getMessage('msg-one')).toBeDefined()
      expect(recovered.getMessage('msg-two')).toBeDefined()

      await expect(recovered.accept(input('req-three'))).resolves.toMatchObject({
        accepted: true,
        message: { id: 'msg-three' },
      })
      expect(JSON.parse(readFileSync(paths.backup, 'utf8')).messages)
        .toHaveLength(3)
      const replacement = open()
      expect(replacement.getMessage('msg-one')).toBeDefined()
      expect(replacement.getMessage('msg-three')).toBeDefined()
    })
  })

  it('falls back when retained intent no longer matches its fingerprint', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-fingerprint'] })
      await ledger.accept(input('req-fingerprint'))
      const corrupted = JSON.parse(readFileSync(paths.primary, 'utf8'))
      corrupted.messages[0].text = 'corrupted work'
      writeFileSync(paths.primary, JSON.stringify(corrupted))

      const recovered = open()
      expect(recovered.health).toBe('recovered')
      expect(recovered.getMessage('msg-fingerprint')?.message.text)
        .toBe('Please inspect the lifecycle race.')

      writeFileSync(paths.primary, JSON.stringify(corrupted))
      writeFileSync(paths.backup, JSON.stringify(corrupted))
      const faulted = open()
      expect(faulted.health).toBe('faulted-read-only')
      expect(faulted.fault?.primary).toMatchObject({
        kind: 'malformed',
        detail: 'message msg-fingerprint does not match its request fingerprint',
      })
    })
  })

  it('rejects provider-owned detail injected into persisted domain records', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-provider-detail'] })
      const accepted = await ledger.accept(input('req-provider-detail'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      await ledger.transition({
        deliveryId: accepted.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next: {
          state: 'in-flight',
          attempt: 1,
          evidence: {
            source: { id: 'rollout', label: 'Codex rollout' },
            reference: 'event-1',
          },
        },
      })
      const base = JSON.parse(readFileSync(paths.primary, 'utf8'))
      const corruptions: Array<(snapshot: typeof base) => void> = [
        snapshot => { snapshot.messages[0].providerDetail = 'leak' },
        snapshot => { snapshot.messages[0].sender.providerDetail = 'leak' },
        snapshot => { snapshot.messages[0].destination.providerDetail = 'leak' },
        snapshot => { snapshot.deliveries[0].providerDetail = 'leak' },
        snapshot => { snapshot.deliveries[0].recipient.providerDetail = 'leak' },
        snapshot => { snapshot.deliveries[0].history[1].providerDetail = 'leak' },
        snapshot => { snapshot.deliveries[0].history[1].evidence.providerDetail = 'leak' },
        snapshot => {
          snapshot.deliveries[0].history[1].evidence.source.providerDetail = 'leak'
        },
      ]

      for (const corrupt of corruptions) {
        const snapshot = structuredClone(base)
        corrupt(snapshot)
        const invalid = JSON.stringify(snapshot)
        writeFileSync(paths.primary, invalid)
        writeFileSync(paths.backup, invalid)
        const faulted = open()
        expect(faulted.health).toBe('faulted-read-only')
        expect(faulted.fault?.primary?.kind).toBe('malformed')
        expect(faulted.fault?.backup?.kind).toBe('malformed')
      }
    })
  })

  it('rejects a delivery whose acceptance time diverges from its message', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-divergent-time'], now: () => 1_000 })
      await ledger.accept(input('req-divergent-time'))
      const snapshot = JSON.parse(readFileSync(paths.primary, 'utf8'))
      const changedAt = '1970-01-01T00:00:02.000Z'
      snapshot.deliveries[0].acceptedAt = changedAt
      snapshot.deliveries[0].updatedAt = changedAt
      snapshot.deliveries[0].history[0].at = changedAt
      const invalid = JSON.stringify(snapshot)
      writeFileSync(paths.primary, invalid)

      const recovered = open()
      expect(recovered.health).toBe('recovered')
      expect(recovered.getMessage('msg-divergent-time')).toBeDefined()

      writeFileSync(paths.primary, invalid)
      writeFileSync(paths.backup, invalid)
      const faulted = open()
      expect(faulted.health).toBe('faulted-read-only')
      expect(faulted.fault?.primary).toMatchObject({
        kind: 'malformed',
        detail: 'delivery msg-divergent-time/d/1 has a different acceptance time than msg-divergent-time',
      })
    })
  })

  it('does not downgrade an unknown primary schema through an older backup', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-newer-schema'] })
      await ledger.accept(input('req-newer-schema'))
      const primary = JSON.parse(readFileSync(paths.primary, 'utf8'))
      primary.version = DELIVERY_LEDGER_SCHEMA_VERSION + 1
      writeFileSync(paths.primary, JSON.stringify(primary))
      const backup = readFileSync(paths.backup, 'utf8')

      const faulted = open()
      expect(faulted.health).toBe('faulted-read-only')
      expect(faulted.fault?.primary?.kind).toBe('unknown-version')
      expect(faulted.fault?.backup).toBeUndefined()
      await expect(faulted.accept(input('req-refused-downgrade'))).resolves.toEqual({
        accepted: false,
        reason: 'faulted-read-only',
      })
      expect(readFileSync(paths.backup, 'utf8')).toBe(backup)
    })
  })

  it('does not overwrite an unknown backup schema from an older primary', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-older-primary'] })
      await ledger.accept(input('req-older-primary'))
      const primary = readFileSync(paths.primary, 'utf8')
      const backup = JSON.parse(readFileSync(paths.backup, 'utf8'))
      backup.version = DELIVERY_LEDGER_SCHEMA_VERSION + 1
      writeFileSync(paths.backup, JSON.stringify(backup))

      const faulted = open()
      expect(faulted.health).toBe('faulted-read-only')
      expect(faulted.fault?.primary).toBeUndefined()
      expect(faulted.fault?.backup?.kind).toBe('unknown-version')
      await expect(faulted.accept(input('req-refused-backup-downgrade')))
        .resolves.toEqual({ accepted: false, reason: 'faulted-read-only' })
      expect(readFileSync(paths.primary, 'utf8')).toBe(primary)
    })
  })

  it('rejects parseable snapshots whose history crosses a terminal state', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-history-one', 'msg-history-two'] })
      await ledger.accept(input('req-history-one'))
      await ledger.accept(input('req-history-two'))

      const snapshot = JSON.parse(readFileSync(paths.primary, 'utf8'))
      const delivery = snapshot.deliveries.find((record: { messageId: string }) =>
        record.messageId === 'msg-history-two')
      const acceptedAt = Date.parse(delivery.acceptedAt)
      const at = (offset: number) => new Date(acceptedAt + offset).toISOString()
      delivery.state = 'in-flight'
      delivery.attempt = 2
      delivery.updatedAt = at(3)
      delivery.history = [
        { state: 'accepted', attempt: 0, at: delivery.acceptedAt },
        { state: 'in-flight', attempt: 1, at: at(1) },
        { state: 'delivered', attempt: 1, at: at(2) },
        { state: 'in-flight', attempt: 2, at: at(3) },
      ]
      const invalid = JSON.stringify(snapshot)
      writeFileSync(paths.primary, invalid)

      const recovered = open()
      expect(recovered.health).toBe('recovered')
      expect(recovered.getMessage('msg-history-one')).toBeDefined()
      expect(recovered.getMessage('msg-history-two')).toBeDefined()

      writeFileSync(paths.primary, invalid)
      writeFileSync(paths.backup, invalid)
      const faulted = open()
      expect(faulted.health).toBe('faulted-read-only')
      expect(faulted.fault?.primary?.kind).toBe('malformed')
      expect(faulted.fault?.backup?.kind).toBe('malformed')
    })
  })

  it('rejects a retained message whose delivery detail disappeared', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-lost-detail'] })
      await ledger.accept(input('req-lost-detail'))
      const snapshot = JSON.parse(readFileSync(paths.primary, 'utf8'))
      snapshot.deliveries = []
      const invalid = JSON.stringify(snapshot)
      writeFileSync(paths.primary, invalid)
      writeFileSync(paths.backup, invalid)

      const faulted = open()
      expect(faulted.health).toBe('faulted-read-only')
      expect(faulted.fault?.primary).toMatchObject({
        kind: 'malformed',
        detail: 'message msg-lost-detail references unknown delivery msg-lost-detail/d/1',
      })
    })
  })

  it('fails read-only when accepted obligations cannot be recovered', async () => {
    await withLedger(async ({ paths, open }) => {
      writeFileSync(paths.primary, '{not-json')
      writeFileSync(paths.backup, JSON.stringify({
        version: DELIVERY_LEDGER_SCHEMA_VERSION + 1,
        messages: [],
        deliveries: [],
      }))
      const primary = readFileSync(paths.primary, 'utf8')
      const backup = readFileSync(paths.backup, 'utf8')

      const ledger = open()
      expect(ledger.health).toBe('faulted-read-only')
      expect(ledger.fault?.primary?.kind).toBe('unparsable')
      expect(ledger.fault?.backup?.kind).toBe('unknown-version')
      await expect(ledger.accept(input('req-refused'))).resolves.toEqual({
        accepted: false,
        reason: 'faulted-read-only',
      })
      expect(readFileSync(paths.primary, 'utf8')).toBe(primary)
      expect(readFileSync(paths.backup, 'utf8')).toBe(backup)
      expect(existsSync(paths.temp)).toBe(false)
    })
  })

  it('does not acknowledge a pre-rename failure or install it in memory', async () => {
    await withLedger(async ({ open }) => {
      const ledger = open({
        ids: ['msg-not-accepted'],
        beforeStep: step => {
          if (step === 'rename-primary') throw new Error('disk failed before rename')
        },
      })
      await expect(ledger.accept(input('req-not-accepted'))).resolves.toMatchObject({
        accepted: false,
        reason: 'write-failed',
      })
      expect(ledger.getMessage('msg-not-accepted')).toBeUndefined()
      expect(ledger.health).toBe('healthy')
    })
  })

  it('freezes after a post-rename durability failure and recovers by request ID on reopen', async () => {
    await withLedger(async ({ open }) => {
      const uncertain = open({
        ids: ['msg-uncertain'],
        beforeStep: step => {
          if (step === 'fsync-dir') throw new Error('directory fsync failed')
        },
      })
      await expect(uncertain.accept(input('req-uncertain'))).resolves.toMatchObject({
        accepted: false,
        reason: 'write-uncertain',
      })
      expect(uncertain.health).toBe('write-uncertain')
      await expect(uncertain.accept(input('req-blocked'))).resolves.toEqual({
        accepted: false,
        reason: 'write-uncertain',
      })

      const replacement = open({ ids: ['msg-unused'] })
      expect(replacement.health).toBe('healthy')
      await expect(replacement.accept(input('req-uncertain'))).resolves.toMatchObject({
        accepted: true,
        replayed: true,
        message: { id: 'msg-uncertain' },
      })
    })
  })
})

describe('DeliveryLedger transitions and retention', () => {
  it('guards state and attempt changes with the durable current value', async () => {
    await withLedger(async ({ paths, open }) => {
      let now = 1_000
      const ledger = open({ ids: ['msg-state'], now: () => now })
      const accepted = await ledger.accept(input('req-state'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      const deliveryId = accepted.deliveries[0]!.id

      now = 2_000
      const inFlight = await ledger.transition({
        deliveryId,
        expected: { state: 'accepted', attempt: 0 },
        next: { state: 'in-flight', attempt: 1 },
      })
      expect(inFlight).toMatchObject({
        updated: true,
        delivery: { id: deliveryId, messageId: 'msg-state', attempt: 1 },
      })

      const bytes = readFileSync(paths.primary, 'utf8')
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'accepted', attempt: 0 },
        next: { state: 'delivered', attempt: 1 },
      })).resolves.toMatchObject({ updated: false, reason: 'stale-delivery' })
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'in-flight', attempt: 1 },
        next: { state: 'in-flight', attempt: 3 },
      })).resolves.toMatchObject({ updated: false, reason: 'invalid-transition' })
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'in-flight', attempt: 1 },
        next: { state: 'pending', attempt: 0 },
      })).resolves.toMatchObject({ updated: false, reason: 'invalid-transition' })
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'in-flight', attempt: 1 },
        next: { state: 'in-flight', attempt: 1 },
      })).resolves.toMatchObject({ updated: false, reason: 'invalid-transition' })
      expect(readFileSync(paths.primary, 'utf8')).toBe(bytes)

      now = 3_000
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'in-flight', attempt: 1 },
        next: {
          state: 'failed',
          attempt: 1,
          reason: 'recipient stopped',
          retryable: false,
        },
      })).resolves.toMatchObject({
        updated: true,
        delivery: {
          id: deliveryId,
          messageId: 'msg-state',
          state: 'failed',
          attempt: 1,
        },
      })
      expect(ledger.listRecoverable()).toEqual([])
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'failed', attempt: 1 },
        next: { state: 'in-flight', attempt: 2 },
      })).resolves.toMatchObject({ updated: false, reason: 'invalid-transition' })
    })
  })

  it('owns normalized transition evidence before queued work begins', async () => {
    await withLedger(async ({ paths, open }) => {
      let holdWrite = false
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const atWrite = new Promise<void>(resolve => { entered = resolve })
      const ledger = open({
        ids: ['msg-owned-event', 'msg-blocker'],
        beforeStep: async step => {
          if (holdWrite && step === 'write-temp') {
            entered()
            await held
          }
        },
      })
      const accepted = await ledger.accept(input('req-owned-event'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      const next = {
        state: 'in-flight' as const,
        attempt: 1,
        evidence: {
          source: { id: 'codex-rollout', label: 'Codex rollout' },
          reference: 'event-1',
          providerSecret: () => 'must not persist',
        },
        providerDetail: () => 'must not persist',
      }

      holdWrite = true
      const blocking = ledger.accept(input('req-blocker'))
      await atWrite
      const transitioning = ledger.transition({
        deliveryId: accepted.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next,
      })
      next.evidence.source.label = 'mutated during write'
      next.evidence.reference = 'event-mutated'
      release()
      await expect(blocking).resolves.toMatchObject({ accepted: true })
      await expect(transitioning).resolves.toMatchObject({ updated: true })

      const event = ledger.getDelivery(accepted.deliveries[0]!.id)?.history.at(-1)
      expect(event).toEqual({
        state: 'in-flight',
        attempt: 1,
        at: expect.any(String),
        evidence: {
          source: { id: 'codex-rollout', label: 'Codex rollout' },
          reference: 'event-1',
        },
      })
      const persisted = JSON.parse(readFileSync(paths.primary, 'utf8'))
      expect(persisted.deliveries[0].history.at(-1)).toEqual(event)
    })
  })

  it('returns structured rejections for malformed nested runtime input', async () => {
    await withLedger(async ({ paths, open }) => {
      const ledger = open({ ids: ['msg-malformed-input'] })
      await expect(ledger.accept({
        ...input('req-malformed-accept'),
        recipients: null,
      } as unknown as DeliveryAcceptInput)).resolves.toMatchObject({
        accepted: false,
        reason: 'invalid-request',
      })

      const sparseRecipients = new Array<
        DeliveryAcceptInput['recipients'][number]
      >(1)
      await expect(ledger.accept({
        ...input('req-sparse-recipients'),
        recipients: sparseRecipients,
      })).resolves.toMatchObject({
        accepted: false,
        reason: 'invalid-request',
        detail: 'every recipient must be complete',
      })
      expect(ledger.health).toBe('healthy')

      const accepted = await ledger.accept(input('req-malformed-transition'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      const durableBeforeMalformedTransition = readFileSync(paths.primary, 'utf8')
      await expect(ledger.transition({
        deliveryId: accepted.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next: {
          state: 'in-flight',
          attempt: 1,
          reason: { provider: 'not-a-string' },
        },
      } as unknown as DeliveryTransitionInput)).resolves.toEqual({
        updated: false,
        reason: 'invalid-transition',
        detail: 'reason must be a string',
      })
      expect(readFileSync(paths.primary, 'utf8'))
        .toBe(durableBeforeMalformedTransition)
      expect(ledger.health).toBe('healthy')

      await expect(ledger.transition({
        deliveryId: accepted.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next: {
          state: 'in-flight',
          attempt: 1,
          evidence: {},
        },
      } as unknown as DeliveryTransitionInput)).resolves.toMatchObject({
        updated: false,
        reason: 'invalid-transition',
        detail: 'evidence is malformed',
      })

      const poisonedError = {}
      Object.defineProperty(poisonedError, 'message', {
        get() { throw new Error('poisoned message getter') },
      })
      const poisonedRequest = input('req-poisoned-capture')
      Object.defineProperty(poisonedRequest, 'requestId', {
        get() { throw poisonedError },
      })
      await expect(ledger.accept(poisonedRequest)).resolves.toMatchObject({
        accepted: false,
        reason: 'invalid-request',
        detail: 'request could not be captured: unknown capture failure',
      })

      const poisonedTransition = {
        deliveryId: accepted.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next: { state: 'in-flight', attempt: 1 },
      }
      Object.defineProperty(poisonedTransition.next, 'evidence', {
        get() { throw poisonedError },
      })
      await expect(ledger.transition(
        poisonedTransition as DeliveryTransitionInput,
      )).resolves.toMatchObject({
        updated: false,
        reason: 'invalid-transition',
        detail: 'transition could not be captured: unknown capture failure',
      })
    })
  })

  it('reports ledger health before malformed capture errors', async () => {
    await withLedger(async ({ open }) => {
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const atDirectorySync = new Promise<void>(resolve => { entered = resolve })
      const ledger = open({
        ids: ['msg-health-precedence'],
        beforeStep: async step => {
          if (step === 'fsync-dir') {
            entered()
            await held
            throw new Error('directory fsync failed')
          }
        },
      })
      const makingUncertain = ledger.accept(input('req-health-precedence'))
      await atDirectorySync
      let malformedAcceptSettled = false
      let malformedTransitionSettled = false
      const malformedAccept = ledger.accept({
        ...input('req-malformed-health'),
        recipients: null,
      } as unknown as DeliveryAcceptInput)
      const malformedTransition = ledger.transition({
        deliveryId: 'missing',
        expected: { state: 'accepted', attempt: 0 },
        next: { state: 'in-flight', attempt: 1, evidence: {} },
      } as unknown as DeliveryTransitionInput)
      void malformedAccept.then(() => { malformedAcceptSettled = true })
      void malformedTransition.then(() => { malformedTransitionSettled = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(malformedAcceptSettled).toBe(false)
      expect(malformedTransitionSettled).toBe(false)

      release()
      await expect(makingUncertain)
        .resolves.toMatchObject({ accepted: false, reason: 'write-uncertain' })
      await expect(malformedAccept).resolves.toEqual({
        accepted: false,
        reason: 'write-uncertain',
      })
      await expect(malformedTransition).resolves.toEqual({
        updated: false,
        reason: 'write-uncertain',
      })
    })
  })

  it('keeps the initial event and a valid tail when history is bounded', async () => {
    await withLedger(async ({ open }) => {
      let now = 1_000
      const ledger = open({
        ids: ['msg-bounded-history'],
        now: () => now,
        maxHistoryEntries: 4,
      })
      const accepted = await ledger.accept(input('req-bounded-history'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      const deliveryId = accepted.deliveries[0]!.id
      const advance = async (
        expected: { state: 'accepted' | 'in-flight' | 'failed'; attempt: number },
        next: {
          state: 'in-flight' | 'failed'
          attempt: number
          reason?: string
          retryable?: boolean
        },
      ) => {
        now++
        await expect(ledger.transition({ deliveryId, expected, next }))
          .resolves.toMatchObject({ updated: true })
      }
      await advance(
        { state: 'accepted', attempt: 0 },
        { state: 'in-flight', attempt: 1 },
      )
      await advance(
        { state: 'in-flight', attempt: 1 },
        { state: 'failed', attempt: 1, reason: 'retry one', retryable: true },
      )
      await advance(
        { state: 'failed', attempt: 1 },
        { state: 'in-flight', attempt: 2 },
      )
      await advance(
        { state: 'in-flight', attempt: 2 },
        { state: 'failed', attempt: 2, reason: 'retry two', retryable: true },
      )
      await advance(
        { state: 'failed', attempt: 2 },
        { state: 'in-flight', attempt: 3 },
      )

      const replacement = open({ maxHistoryEntries: 4 })
      const recovered = replacement.getDelivery(deliveryId)
      expect(recovered).toMatchObject({
        state: 'in-flight',
        attempt: 3,
        historyTruncated: true,
      })
      expect(recovered?.history).toHaveLength(4)
      expect(recovered?.history[0]).toMatchObject({ state: 'accepted', attempt: 0 })
      expect(recovered?.history.slice(1).map(event => [event.state, event.attempt]))
        .toEqual([
          ['in-flight', 2],
          ['failed', 2],
          ['in-flight', 3],
        ])
    })
  })

  it('never transitions a delivered record back into active work', async () => {
    await withLedger(async ({ open }) => {
      const ledger = open({ ids: ['msg-delivered-terminal'] })
      const accepted = await ledger.accept(input('req-delivered-terminal'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      const deliveryId = accepted.deliveries[0]!.id
      await ledger.transition({
        deliveryId,
        expected: { state: 'accepted', attempt: 0 },
        next: { state: 'in-flight', attempt: 1 },
      })
      await ledger.transition({
        deliveryId,
        expected: { state: 'in-flight', attempt: 1 },
        next: { state: 'delivered', attempt: 1 },
      })
      await expect(ledger.transition({
        deliveryId,
        expected: { state: 'delivered', attempt: 1 },
        next: { state: 'in-flight', attempt: 2 },
      })).resolves.toMatchObject({ updated: false, reason: 'invalid-transition' })
    })
  })

  it('serializes concurrent accepts without losing either message', async () => {
    await withLedger(async ({ open }) => {
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      let holdOnce = true
      const steps: DeliveryLedgerWriteStep[] = []
      const ledger = open({
        ids: ['msg-a', 'msg-b'],
        beforeStep: async step => {
          steps.push(step)
          if (step === 'fsync-temp' && holdOnce) {
            holdOnce = false
            await held
          }
        },
      })
      const a = ledger.accept(input('req-a'))
      const b = ledger.accept(input('req-b'))
      await new Promise(resolve => setImmediate(resolve))
      expect(steps).toEqual(['write-temp', 'fsync-temp'])
      release()
      await expect(a).resolves.toMatchObject({ accepted: true })
      await expect(b).resolves.toMatchObject({ accepted: true })

      expect(ledger.getMessage('msg-a')).toBeDefined()
      expect(ledger.getMessage('msg-b')).toBeDefined()
      expect(steps).toEqual([
        'write-temp', 'fsync-temp', 'write-backup-temp',
        'rename-primary', 'rename-backup', 'fsync-dir',
        'write-temp', 'fsync-temp', 'write-backup-temp',
        'rename-primary', 'rename-backup', 'fsync-dir',
      ])
    })
  })

  it('prunes only terminal non-retryable messages by age and count', async () => {
    await withLedger(async ({ open }) => {
      let now = 0
      const ledger = open({
        ids: ['msg-old-final', 'msg-active', 'msg-retryable', 'msg-new-final'],
        now: () => now,
        retentionMs: 100,
        maxTerminalMessages: 1,
      })

      const acceptAndFail = async (requestId: string, retryable: boolean) => {
        const accepted = await ledger.accept(input(requestId))
        if (!accepted.accepted || accepted.details !== 'retained') {
          throw new Error('expected retained acceptance')
        }
        const deliveryId = accepted.deliveries[0]!.id
        await ledger.transition({
          deliveryId,
          expected: { state: 'accepted', attempt: 0 },
          next: {
            state: 'failed',
            attempt: 0,
            reason: retryable ? 'broker unavailable' : 'recipient deleted',
            retryable,
          },
        })
        return accepted.message.id
      }

      const oldFinal = await acceptAndFail('req-old-final', false)
      now = 50
      const active = await ledger.accept(input('req-active'))
      if (!active.accepted || active.details !== 'retained') {
        throw new Error('expected retained active acceptance')
      }
      const retryable = await acceptAndFail('req-retryable', true)
      now = 200
      const newFinal = await acceptAndFail('req-new-final', false)

      expect(ledger.getMessage(oldFinal)).toBeUndefined()
      expect(ledger.getMessage(active.message.id)).toBeDefined()
      expect(ledger.getMessage(retryable)).toBeDefined()
      expect(ledger.getMessage(newFinal)).toBeDefined()
      expect(ledger.listRecoverable().map(delivery => delivery.messageId).sort())
        .toEqual([active.message.id, retryable].sort())
    })
  })

  it('enforces the terminal message count without pruning active work', async () => {
    await withLedger(async ({ paths, open }) => {
      let now = 0
      const ledger = open({
        ids: ['msg-old-count', 'msg-active-count', 'msg-retry-count', 'msg-new-count'],
        now: () => now,
        retentionMs: 10_000,
        maxTerminalMessages: 1,
      })
      const finalize = async (requestId: string, retryable: boolean) => {
        const accepted = await ledger.accept(input(requestId))
        if (!accepted.accepted || accepted.details !== 'retained') {
          throw new Error('expected retained count acceptance')
        }
        now++
        await ledger.transition({
          deliveryId: accepted.deliveries[0]!.id,
          expected: { state: 'accepted', attempt: 0 },
          next: {
            state: 'failed',
            attempt: 0,
            reason: retryable ? 'broker unavailable' : 'recipient deleted',
            retryable,
          },
        })
        return accepted
      }

      const oldFinal = await finalize('req-old-count', false)
      now++
      const active = await ledger.accept(input('req-active-count'))
      if (!active.accepted || active.details !== 'retained') {
        throw new Error('expected retained active acceptance')
      }
      now++
      const retryable = await finalize('req-retry-count', true)
      now++
      const newFinal = await finalize('req-new-count', false)

      expect(ledger.getMessage(oldFinal.message.id)).toBeUndefined()
      expect(ledger.getDelivery(oldFinal.deliveries[0]!.id)).toBeUndefined()
      expect(ledger.getMessage(active.message.id)).toBeDefined()
      expect(ledger.getMessage(retryable.message.id)).toBeDefined()
      expect(ledger.getMessage(newFinal.message.id)).toBeDefined()
      const snapshot = JSON.parse(readFileSync(paths.primary, 'utf8'))
      expect(snapshot.messages.map((message: { id: string }) => message.id).sort())
        .toEqual([
          active.message.id,
          retryable.message.id,
          newFinal.message.id,
        ].sort())

      const replacement = open({ retentionMs: 10_000, maxTerminalMessages: 1 })
      expect(replacement.getMessage(oldFinal.message.id)).toBeUndefined()
      expect(replacement.listRecoverable().map(delivery => delivery.messageId).sort())
        .toEqual([active.message.id, retryable.message.id].sort())
    })
  })

  it('bounds request identity with the terminal detail retention policy', async () => {
    await withLedger(async ({ paths, open }) => {
      let now = 0
      const ledger = open({
        ids: ['msg-pruned', 'msg-trigger', 'msg-reaccepted'],
        now: () => now,
        retentionMs: 0,
      })
      const accepted = await ledger.accept(input('req-pruned'))
      if (!accepted.accepted || accepted.details !== 'retained') {
        throw new Error('expected retained acceptance')
      }
      await ledger.transition({
        deliveryId: accepted.deliveries[0]!.id,
        expected: { state: 'accepted', attempt: 0 },
        next: {
          state: 'failed',
          attempt: 0,
          reason: 'recipient deleted',
          retryable: false,
        },
      })

      now = 1
      await ledger.accept(input('req-trigger'))
      expect(ledger.getMessage('msg-pruned')).toBeUndefined()
      const snapshot = JSON.parse(readFileSync(paths.primary, 'utf8'))
      expect(snapshot.messages.find(
        (record: { requestId: string }) => record.requestId === 'req-pruned',
      )).toBeUndefined()
      const reacceptedInput = input('req-pruned', {
        text: 'new logical work after retention',
      })
      await expect(ledger.accept(reacceptedInput)).resolves.toMatchObject({
        accepted: true,
        replayed: false,
        wrote: true,
        details: 'retained',
        receipt: {
          requestId: 'req-pruned',
          messageId: 'msg-reaccepted',
          deliveryIds: ['msg-reaccepted/d/1'],
        },
      })
      await expect(ledger.accept(input('req-pruned')))
        .resolves.toMatchObject({
          accepted: false,
          reason: 'request-id-reuse',
        })

      const replacement = open({ ids: ['msg-never-used'], now: () => now })
      await expect(replacement.accept(reacceptedInput)).resolves.toMatchObject({
        accepted: true,
        replayed: true,
        details: 'retained',
        receipt: { messageId: 'msg-reaccepted' },
      })
    })
  })
})
