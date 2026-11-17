import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, linkSync, unlinkSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import { createRequire as createSqliteRequire } from 'node:module'
import { getConfigRoot } from '../configRoot'

export const leaseDuration = 60 * 60 * 1000
// Provider requests have 20-second deadlines. Allow five minutes for an
// interrupted request to settle before using complete readback to release it.
export const sourceWriteRecoveryAge = 5 * 60 * 1000
export const leaseHash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Same authenticated boundary as session_probe; client metadata grants no authority. */
export const leaseCaller = (actor: string, headers: IncomingHttpHeaders) => leaseHash(JSON.stringify([actor, headers.authorization, headers['x-tinstar-caller-authorization']]))
const access = new AsyncLocalStorage<{ caller: string; token?: string }>()
export const withLeaseCaller = <T>(caller: string, token: string | undefined, perform: () => T) => access.run({ caller, token }, perform)
export interface LeaseRow { card: string; generation: number; caller: string | null; holder: string | null; token_hash: string | null; expires: number }
export interface CardLease { card_id: string; generation: number; holder: string; expires_at: string }
interface ClaimAdmission { eligible(card: string): boolean; sourceRevision: number }
export class CardLeaseError extends Error {
  readonly code = 'card-held'
  constructor(readonly lease: CardLease | null, message?: string) { super(message ?? (lease ? `held by ${lease.holder} until ${lease.expires_at}` : 'Claim lost; re-read and claim the card again')) }
}
export interface SourceWriteIntent { readback_can_settle?: boolean; kind: 'properties' | 'append' | 'section' | 'note' | 'reminder'; [key: string]: unknown }
const writeEvent = (intent: SourceWriteIntent | null | undefined, event: string) => `${intent?.kind === 'reminder' ? 'reminder' : 'write'}-${event}`
export class SourceWritePending extends CardLeaseError {
  constructor() { super(null, 'Source write unresolved; inspect and reconcile the reserved operation before retrying') }
}
// This only lets same-process, exact-card calls await an operation already running.
// The durable reservation, never this map, fences other processes and crashes.
const sourceOperationAccess = new AsyncLocalStorage<string>()
export const withSourceOperation = <T>(actor: string, operation: string, perform: () => T) => sourceOperationAccess.run(leaseHash(JSON.stringify([access.getStore()?.caller ?? actor, operation])), perform)
const sourceWriteAccess = new AsyncLocalStorage<{ dispatched: boolean }>()
export const sourceWriteDispatched = () => { const context = sourceWriteAccess.getStore(); if (context) context.dispatched = true }
const runningWrites = new Map<string, Promise<unknown>>()
export const leaseFailure = (error: CardLeaseError, operation_id = '') => ({ outcome: 'not-saved' as const, code: error instanceof SourceWritePending ? 'source-write-pending' : error.lease ? 'card-held' : 'claim-lost', message: error.message, operation_id, saved_fields: [], lease: error.lease })
export const publicLease = (row: LeaseRow): CardLease => ({ card_id: row.card, generation: row.generation, holder: row.holder!, expires_at: new Date(row.expires).toISOString() })

/** Short SQLite transactions fence each card before provider I/O. Unresolved
 * writes require source readback, through aged recovery or owner reconciliation;
 * age alone never clears a reservation. */
export class CardLeases {
  onChange?: () => void
  private path: string
  private secret: string
  constructor(root = getConfigRoot(), private now = Date.now) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const secretPath = join(root, 'card-lease-key')
    try { this.secret = readFileSync(secretPath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Publish a complete key atomically: simultaneous first starts must not
      // read an empty, newly opened key file before its creator writes it.
      const candidate = join(root, `.card-lease-key-${randomBytes(12).toString('hex')}`)
      writeFileSync(candidate, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      try { linkSync(candidate, secretPath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      finally { unlinkSync(candidate) }
    }
    chmodSync(secretPath, 0o600)
    this.secret = readFileSync(secretPath, 'utf8')
    this.path = join(root, 'card-leases.sqlite')
    const db = this.database()
    try {
      // Changing journal mode can return BUSY without invoking SQLite's busy handler.
      const deadline = Date.now() + 5000
      for (;;) {
        try { db.exec('PRAGMA journal_mode=WAL'); break }
        catch (error) {
          if ((((error as { errcode?: number }).errcode ?? 0) & 0xff) !== 5 || Date.now() >= deadline) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        }
      }
      if ((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('leases','receipts')").get() as { n: number }).n !== 2) db.exec(`
        CREATE TABLE IF NOT EXISTS leases (card TEXT PRIMARY KEY, generation INTEGER NOT NULL, caller TEXT, holder TEXT, token_hash TEXT, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (caller TEXT, operation TEXT, signature TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(caller, operation));`)
      db.exec(`CREATE TABLE IF NOT EXISTS source_write_reservations (card TEXT PRIMARY KEY, operation TEXT NOT NULL, generation INTEGER NOT NULL, intent TEXT, started INTEGER NOT NULL, source_operation TEXT);
        CREATE TABLE IF NOT EXISTS lease_events (sequence INTEGER PRIMARY KEY, card TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL);`)
      chmodSync(this.path, 0o600)
    } finally { db.close() }
  }
  private database(waitForRecovery = true) {
    // Load only when opening a lease database; importing errors/types needs no SQLite.
    // Load through Node because Vitest 2's Vite predates this built-in module.
    const { DatabaseSync }: typeof import('node:sqlite') = createSqliteRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(this.path)
    // Concurrent open/last-close can briefly recover the WAL, even on a read.
    // Use SQLite's busy handler for that short recovery/schema lock. Mutation
    // transactions instead yield asynchronously while another writer awaits IO.
    db.exec(`PRAGMA busy_timeout=${waitForRecovery ? 5000 : 0}`)
    return db
  }
  rowInStorage(db: SqliteDatabase, card: string) { return db.prepare('SELECT * FROM leases WHERE card = ?').get(card) as unknown as LeaseRow | undefined }
  activeInStorage(row?: LeaseRow): row is LeaseRow & { caller: string } { return !!row?.caller && row.expires > this.now() }
  status(card: string): CardLease | null {
    const db = this.database()
    try { const row = this.rowInStorage(db, card); return this.activeInStorage(row) ? publicLease(row) : null } finally { db.close() }
  }
  private async transaction<T>(perform: (db: SqliteDatabase) => Promise<T> | T): Promise<T> {
    const db = this.database(false)
    try {
      // Busy waits yield to other processes holding a short writer transaction.
      // Provider I/O runs only after its card reservation has committed.
      for (;;) {
        try { db.exec('BEGIN IMMEDIATE'); break }
        catch (error) {
          if ((((error as { errcode?: number }).errcode ?? 0) & 0xff) !== 5) throw error
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      try {
        const pending = perform(db)
        // Do not yield with a synchronous transaction open: another same-process
        // SQLite constructor/read could block the event loop waiting for it.
        const result = pending instanceof Promise ? await pending : pending
        db.exec('COMMIT'); return result
      }
      catch (error) { db.exec('ROLLBACK'); throw error }
    } finally { db.close() }
  }
  /** Internal packet storage uses this same database/transaction boundary so a
   * prepared claims check readiness and reserve the canonical card in
   * one transaction. These helpers do not change generic lease behavior. */
  readStorage<T>(read: (db: SqliteDatabase) => T): T {
    const db = this.database()
    try { return read(db) } finally { db.close() }
  }
  writeStorage<T>(write: (db: SqliteDatabase) => T | Promise<T>): Promise<T> { return this.transaction(write) }
  private check(db: SqliteDatabase, card: string, inspection = false, validateOnly = false) {
    const pending = db.prepare('SELECT source_operation FROM source_write_reservations WHERE card = ?').get(card) as { source_operation: string | null } | undefined
    if (pending && !validateOnly && !(inspection && pending.source_operation && pending.source_operation === sourceOperationAccess.getStore())) throw new SourceWritePending()
    const row = this.rowInStorage(db, card), context = access.getStore()
    const matches = context?.token && this.activeInStorage(row) && row.caller === context.caller && row.token_hash === leaseHash(context.token)
    if (this.activeInStorage(row) && !matches) throw new CardLeaseError(publicLease(row))
    // A presented stale token must never fall through to legacy write access.
    if (context?.token && !matches) throw new CardLeaseError(null)
    return matches ? row : undefined
  }
  // Validation may inspect pending writes; every mutation still checks the fence.
  assertWritable(card: string, validateOnly = false) {
    const db = this.database()
    try { this.check(db, card, true, validateOnly) } finally { db.close() }
  }
  reservedInStorage(db: SqliteDatabase, card: string) {
    return !!db.prepare('SELECT 1 FROM source_write_reservations WHERE card = ?').get(card)
  }
  /** Reminder comments do not change workflow meaning. Keep their write fence,
   * but allow review/claim admission while delivery is pending. */
  reviewReservedInStorage(db: SqliteDatabase, card: string) {
    const pending = db.prepare('SELECT intent FROM source_write_reservations WHERE card = ?').get(card) as { intent: string | null } | undefined
    return !!pending && (!pending.intent || JSON.parse(pending.intent).kind !== 'reminder')
  }
  auditInStorage(db: SqliteDatabase, card: string, type: string, detail: unknown) {
    db.prepare('INSERT INTO lease_events(card,type,at,detail) VALUES(?,?,?,?)').run(card, type, this.now(), JSON.stringify(detail))
  }
  async mutate<T>(card: string, perform: () => Promise<T>, intent?: SourceWriteIntent, probe?: (intent: SourceWriteIntent) => Promise<'applied' | 'different' | 'unknown'>) {
    const key = JSON.stringify([this.path, card]), operation = randomUUID()
    const run = async () => {
      const generation = await this.transaction(db => {
        const row = this.check(db, card), generation = row?.generation ?? this.rowInStorage(db, card)?.generation ?? 0
        db.prepare('INSERT INTO source_write_reservations VALUES(?,?,?,?,?,?)').run(card, operation, generation, intent ? JSON.stringify(intent) : null, this.now(), sourceOperationAccess.getStore() ?? null)
        this.auditInStorage(db, card, writeEvent(intent, 'reserved'), { operation, generation })
        return row?.generation
      })
      const dispatch = { dispatched: false }
      let completed = false, rejected = false
      try {
        const result = await sourceWriteAccess.run(dispatch, perform)
        completed = true
        return result
      } catch (error) {
        const rejection = error as { status?: number; method?: string }
        const definite = rejection.status !== undefined && rejection.status >= 400 && rejection.status < 500 && rejection.status !== 408 && rejection.method !== 'GET'
        rejected = !intent || !dispatch.dispatched || definite
        throw error
      } finally {
        // Immutable note/receipt readback can establish success after a lost
        // response. Absence is not safe yet: aged recovery will read it again.
        if (!completed && !rejected && intent?.readback_can_settle && probe) {
          completed = await probe(intent).catch(() => 'unknown') === 'applied'
        }
        if (completed || rejected) await this.transaction(db => {
          const removed = db.prepare('DELETE FROM source_write_reservations WHERE card = ? AND operation = ?').run(card, operation)
          if (!removed.changes) return
          if (completed && generation !== undefined) db.prepare('UPDATE leases SET expires = ? WHERE card = ? AND generation = ?').run(this.now() + leaseDuration, card, generation)
          this.auditInStorage(db, card, writeEvent(intent, completed ? 'completed' : 'rejected'), { operation })
        })
      }
    }
    const promise = run()
    // A competing attempt will reject at the durable fence. It must not
    // replace (then erase) the callback that recovery still needs to await.
    if (!runningWrites.has(key)) runningWrites.set(key, promise)
    try { return await promise } finally { if (runningWrites.get(key) === promise) runningWrites.delete(key) }
  }
  events(after = 0, limit = 100) {
    return this.readStorage(db => db.prepare('SELECT * FROM lease_events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, Math.min(500, Math.max(1, Math.trunc(limit)))))
  }
  pendingWrites() {
    return this.readStorage(db => db.prepare('SELECT * FROM source_write_reservations ORDER BY started,card').all() as Array<{ card: string; operation: string; generation: number; intent: string | null; started: number; source_operation: string | null }>)
  }
  async recoverStaleWrites(probe: (card: string, intent: SourceWriteIntent | null) => Promise<'applied' | 'different' | 'unknown'>) {
    for (const pending of this.pendingWrites()) {
      if (pending.started > this.now() - sourceWriteRecoveryAge || runningWrites.has(JSON.stringify([this.path, pending.card]))) continue
      await this.reconcileWrite(pending.card, pending.operation, 'source-write-recovery',
        'Provider deadline and five-minute settlement window elapsed; complete source readback', intent => probe(pending.card, intent))
    }
  }
  async recoverAppliedWrite(card: string, probe: (intent: SourceWriteIntent) => Promise<'applied' | 'different' | 'unknown'>) {
    if (runningWrites.has(JSON.stringify([this.path, card]))) return
    const pending = this.pendingWrites().find(row => row.card === card && row.source_operation && row.source_operation === sourceOperationAccess.getStore())
    const intent: SourceWriteIntent | null = pending?.intent ? JSON.parse(pending.intent) : null
    // Only an immutable, unique receipt can establish completion automatically.
    // Matching mutable properties could predate an older still-in-flight PATCH.
    if (!pending || !intent?.readback_can_settle || await probe(intent) !== 'applied') return
    await this.transaction(db => {
      const removed = db.prepare('DELETE FROM source_write_reservations WHERE card = ? AND operation = ?').run(card, pending.operation)
      if (removed.changes) this.auditInStorage(db, card, writeEvent(intent, 'marker-recovered'), { operation: pending.operation, generation: pending.generation })
    })
  }
  async reconcileWrite(card: string, operation: string, actor: string, reason: string, probe: (intent: SourceWriteIntent | null) => Promise<'applied' | 'different' | 'unknown'>) {
    // Manual callers establish quiescence; automatic recovery waits beyond the
    // provider deadline. Both paths still require complete source readback.
    if (!actor.trim() || !reason.trim()) throw new Error('Recovery actor and settled-request evidence required')
    if (runningWrites.has(JSON.stringify([this.path, card]))) throw new SourceWritePending()
    const pending = this.pendingWrites().find(row => row.card === card && row.operation === operation)
    if (!pending) return { outcome: 'already-reconciled' }
    const intent = pending.intent ? JSON.parse(pending.intent) : null
    const state = await probe(intent)
    if (state === 'unknown') return { outcome: 'source-unavailable', message: 'Complete source readback required; reservation retained' }
    return this.transaction(db => {
      const removed = db.prepare('DELETE FROM source_write_reservations WHERE card = ? AND operation = ? AND generation = ?').run(card, operation, pending.generation)
      if (removed.changes) this.auditInStorage(db, card, writeEvent(intent, 'reconciled'), { operation, generation: pending.generation, actor, reason, source_state: state })
      return { outcome: 'reconciled', source_state: state }
    })
  }
  capability(caller: string, operation: string) { return this.token(caller, operation) }
  private sourceRevisionInStorage(db: SqliteDatabase, card?: string) {
    // Reminder delivery cannot invalidate a workflow snapshot used for claims.
    return (db.prepare(`SELECT coalesce(max(sequence), 0) AS revision FROM lease_events WHERE type LIKE 'write-%'${card ? ' AND card = ?' : ''}`).get(...(card ? [card] : [])) as { revision: number }).revision
  }
  sourceRevision() { return this.readStorage(db => this.sourceRevisionInStorage(db)) }
  private token(caller: string, operation: string) {
    // Reconstruct an identical claim response after a lost response/restart,
    // without storing a plaintext token in a receipt or lease record.
    return createHmac('sha256', this.secret).update(JSON.stringify([caller, operation])).digest('base64url')
  }
  async claim(cards: string[], caller: string, holder: string, operation: string, token?: string, exact = false, admission?: ClaimAdmission) {
    if (cards.length === 1 && this.readStorage(db => this.reviewReservedInStorage(db, cards[0]!))) await runningWrites.get(JSON.stringify([this.path, cards[0]]))?.catch(() => {})
    return this.transaction(db => this.claimInStorage(db, cards, caller, holder, operation, token, exact, admission))
  }
  claimInStorage(db: SqliteDatabase, cards: string[], caller: string, holder: string, operation: string, token?: string, exact = false, admission?: ClaimAdmission) {
    const signature = JSON.stringify([exact ? cards : 'needs-will', token ? leaseHash(token) : null])
    const previous = db.prepare('SELECT signature,result FROM receipts WHERE caller = ? AND operation = ?').get(caller, operation) as { signature: string; result: string } | undefined
    if (previous) {
      if (previous.signature !== signature) return { outcome: 'operation-conflict' }
      const result = JSON.parse(previous.result)
      if (result.outcome !== 'claimed') return result
      const leaseToken = this.token(caller, operation)
      const row = this.rowInStorage(db, result.lease.card_id)
      if (!this.activeInStorage(row) || row.generation !== result.lease.generation || row.caller !== caller || row.token_hash !== leaseHash(leaseToken)) throw new CardLeaseError(null)
      return { ...result, lease: publicLease(row), lease_token: leaseToken }
    }
    if (token) {
      const row = db.prepare('SELECT * FROM leases WHERE token_hash = ? AND caller = ?').get(leaseHash(token), caller) as unknown as LeaseRow | undefined
      if (!this.activeInStorage(row)) throw new CardLeaseError(null)
      if (exact && row.card !== cards[0]) return { outcome: 'already-holding', lease: publicLease(row), message: 'Release the held card before claiming another' }
      return { outcome: 'held', lease: publicLease(row), lease_token: token }
    }
    for (const card of cards) {
      if (this.reviewReservedInStorage(db, card)) { if (exact) throw new SourceWritePending(); continue }
      const old = this.rowInStorage(db, card)
      if (this.activeInStorage(old)) { if (exact) throw new CardLeaseError(publicLease(old)); continue }
      // Recheck admission under the same writer lock as allocation. Receipts
      // and held-token retries above deliberately preserve their original lease.
      // A write to this card crossing queue/history or exact-card reads invalidates its snapshot;
      // in-flight workflow writes are fenced by reviewReservedInStorage above.
      if (admission && (this.sourceRevisionInStorage(db, card) > admission.sourceRevision || !admission.eligible(card))) continue
      const leaseToken = this.token(caller, operation)
      const row: LeaseRow = { card, generation: (old?.generation ?? 0) + 1, caller, holder: `${holder} · chat ${leaseHash(leaseToken).slice(0, 6)}`, token_hash: leaseHash(leaseToken), expires: this.now() + leaseDuration }
      db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?,?)').run(row.card, row.generation, row.caller, row.holder, row.token_hash, row.expires)
      const result = { outcome: 'claimed', lease: publicLease(row) }
      db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(caller, operation, signature, JSON.stringify(result))
      this.onChange?.()
      return { ...result, lease_token: leaseToken }
    }
    return { outcome: 'no-unclaimed-card', message: 'No currently unclaimed actionable card in the covered queue; inspect source coverage and waiting requests' }
  }
  async release(caller: string, token: string, reason: string) {
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM leases WHERE token_hash = ? AND caller = ?').get(leaseHash(token), caller) as unknown as LeaseRow | undefined
      if (!this.activeInStorage(row)) throw new CardLeaseError(null)
      this.releaseInStorage(db, row, reason, caller)
      return { outcome: 'released', card_id: row.card }
    })
  }
  async releaseCurrent(card: string, reason: string) {
    const context = access.getStore()
    if (!context?.token || !this.status(card)) throw new CardLeaseError(null)
    this.assertWritable(card)
    return this.release(context.caller, context.token, reason)
  }
  releaseInStorage(db: SqliteDatabase, row: LeaseRow, reason: string, actor: string) {
    if (this.reservedInStorage(db, row.card)) throw new SourceWritePending()
    this.auditInStorage(db, row.card, 'released', { generation: row.generation, reason, actor })
    this.clear(db, row)
  }
  private clear(db: SqliteDatabase, row: LeaseRow) {
    db.prepare('UPDATE leases SET generation = generation + 1, caller = NULL, holder = NULL, token_hash = NULL, expires = 0 WHERE card = ?').run(row.card)
    this.onChange?.()
  }
  async ownerRelease(card: string, generation: number, reason: string) {
    return this.transaction(db => {
      const row = this.rowInStorage(db, card)
      if (!this.activeInStorage(row)) return { outcome: 'already-released' }
      if (row.generation !== generation) return { outcome: 'claim-changed', message: 'Holder changed; reload before releasing' }
      this.releaseInStorage(db, row, reason, 'owner')
      return { outcome: 'released', card_id: card }
    })
  }
}
