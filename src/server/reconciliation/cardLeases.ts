import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import { createRequire } from 'node:module'
// Load through Node: Vite 5 (used by Vitest 2) predates this built-in module.
const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')
import { getConfigRoot } from '../configRoot'

export const leaseDuration = 60 * 60 * 1000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Same authenticated boundary as session_probe; client metadata grants no authority. */
export const leaseCaller = (actor: string, headers: IncomingHttpHeaders) => hash(JSON.stringify([actor, headers.authorization, headers['x-tinstar-caller-authorization']]))
const access = new AsyncLocalStorage<{ caller: string; token?: string }>()
export const withLeaseCaller = <T>(caller: string, token: string | undefined, perform: () => T) => access.run({ caller, token }, perform)
interface Row { card: string; generation: number; caller: string | null; holder: string | null; token_hash: string | null; expires: number }
export interface CardLease { card_id: string; generation: number; holder: string; expires_at: string }
export class CardLeaseError extends Error {
  readonly code = 'card-held'
  constructor(readonly lease: CardLease | null) { super(lease ? `held by ${lease.holder} until ${lease.expires_at}` : 'Claim lost; re-read and claim the card again') }
}
export const leaseFailure = (error: CardLeaseError, operation_id = '') => ({ outcome: 'not-saved' as const, code: error.lease ? 'card-held' : 'claim-lost', message: error.message, operation_id, saved_fields: [], lease: error.lease })
const publicLease = (row: Row): CardLease => ({ card_id: row.card, generation: row.generation, holder: row.holder!, expires_at: new Date(row.expires).toISOString() })

/** SQLite owns cross-process exclusion and crash recovery. Transactions cover
 * each source mutation as well as claim/release, so expiry cannot admit a new
 * generation while an older holder's source write is in flight. No sweep or
 * process-local token registry is needed. Reads never renew a reservation. */
export class CardLeases {
  private path: string
  private secret: string
  constructor(root = getConfigRoot(), private now = Date.now) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const secretPath = join(root, 'card-lease-key')
    try { writeFileSync(secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    chmodSync(secretPath, 0o600)
    this.secret = readFileSync(secretPath, 'utf8')
    this.path = join(root, 'card-leases.sqlite')
    const db = new DatabaseSync(this.path)
    try {
      if ((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('leases','receipts','events')").get() as { n: number }).n !== 3) db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS leases (card TEXT PRIMARY KEY, generation INTEGER NOT NULL, caller TEXT, holder TEXT, token_hash TEXT, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (caller TEXT, operation TEXT, signature TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(caller, operation));
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, card TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, reason TEXT);`)
      chmodSync(this.path, 0o600)
    } finally { db.close() }
  }
  private row(db: SqliteDatabase, card: string) { return db.prepare('SELECT * FROM leases WHERE card = ?').get(card) as unknown as Row | undefined }
  private active(row?: Row): row is Row & { caller: string } { return !!row?.caller && row.expires > this.now() }
  status(card: string): CardLease | null {
    const db = new DatabaseSync(this.path)
    try { const row = this.row(db, card); return this.active(row) ? publicLease(row) : null } finally { db.close() }
  }
  private async transaction<T>(perform: (db: SqliteDatabase) => Promise<T> | T): Promise<T> {
    const db = new DatabaseSync(this.path)
    try {
      // Busy waits yield the event loop: another request may hold the writer
      // transaction while awaiting the provider. SQLite releases it on crash.
      for (;;) {
        try { db.exec('BEGIN IMMEDIATE'); break }
        catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      try { const result = await perform(db); db.exec('COMMIT'); return result }
      catch (error) { db.exec('ROLLBACK'); throw error }
    } finally { db.close() }
  }
  private check(db: SqliteDatabase, card: string) {
    const row = this.row(db, card), context = access.getStore()
    const matches = context?.token && this.active(row) && row.caller === context.caller && row.token_hash === hash(context.token)
    if (this.active(row) && !matches) throw new CardLeaseError(publicLease(row))
    // A presented stale token must never fall through to legacy write access.
    if (context?.token && !matches) throw new CardLeaseError(null)
    return matches ? row : undefined
  }
  assertWritable(card: string) {
    const db = new DatabaseSync(this.path)
    try { this.check(db, card) } finally { db.close() }
  }
  async mutate<T>(card: string, perform: () => Promise<T>) {
    return this.transaction(async db => {
      const row = this.check(db, card)
      const result = await perform()
      if (row) db.prepare('UPDATE leases SET expires = ? WHERE card = ? AND generation = ?').run(this.now() + leaseDuration, card, row.generation)
      return result
    })
  }
  private event(db: SqliteDatabase, row: Row, kind: string, reason: string | null = null) {
    db.prepare('INSERT INTO events(at,card,generation,kind,reason) VALUES(?,?,?,?,?)').run(this.now(), row.card, row.generation, kind, reason)
    db.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 1000 FROM events)')
  }
  private token(caller: string, operation: string) {
    // Reconstruct an identical claim response after a lost response/restart,
    // without storing a plaintext token in a receipt or lease record.
    return createHmac('sha256', this.secret).update(JSON.stringify([caller, operation])).digest('base64url')
  }
  async claim(cards: string[], caller: string, holder: string, operation: string, token?: string, exact = false) {
    return this.transaction(db => {
      const signature = JSON.stringify([exact ? cards : 'needs-will', token ? hash(token) : null])
      const previous = db.prepare('SELECT signature,result FROM receipts WHERE caller = ? AND operation = ?').get(caller, operation) as { signature: string; result: string } | undefined
      if (previous) {
        if (previous.signature !== signature) return { outcome: 'operation-conflict' }
        const result = JSON.parse(previous.result)
        return { ...result, ...(result.outcome === 'claimed' ? { lease_token: this.token(caller, operation) } : {}) }
      }
      if (token) {
        const row = db.prepare('SELECT * FROM leases WHERE token_hash = ? AND caller = ?').get(hash(token), caller) as unknown as Row | undefined
        if (!this.active(row)) throw new CardLeaseError(null)
        if (exact && row.card !== cards[0]) return { outcome: 'already-holding', lease: publicLease(row), message: 'Release the held card before claiming another' }
        return { outcome: 'held', lease: publicLease(row), lease_token: token }
      }
      for (const card of cards) {
        const old = this.row(db, card)
        if (this.active(old)) { if (exact) throw new CardLeaseError(publicLease(old)); continue }
        if (old?.caller) this.event(db, old, 'expiry')
        const leaseToken = this.token(caller, operation)
        const row: Row = { card, generation: (old?.generation ?? 0) + 1, caller, holder: `${holder} · chat ${hash(leaseToken).slice(0, 6)}`, token_hash: hash(leaseToken), expires: this.now() + leaseDuration }
        db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?,?)').run(row.card, row.generation, row.caller, row.holder, row.token_hash, row.expires)
        this.event(db, row, 'claim')
        const result = { outcome: 'claimed', lease: publicLease(row) }
        db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(caller, operation, signature, JSON.stringify(result))
        return { ...result, lease_token: leaseToken }
      }
      return { outcome: 'no-unclaimed-card', message: 'No currently unclaimed actionable card in the covered queue; inspect source coverage and waiting requests' }
    })
  }
  async release(caller: string, token: string, reason: string) {
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM leases WHERE token_hash = ? AND caller = ?').get(hash(token), caller) as unknown as Row | undefined
      if (!this.active(row)) throw new CardLeaseError(null)
      this.clear(db, row, reason)
      return { outcome: 'released', card_id: row.card }
    })
  }
  private clear(db: SqliteDatabase, row: Row, reason: string) {
    db.prepare('UPDATE leases SET generation = generation + 1, caller = NULL, holder = NULL, token_hash = NULL, expires = 0 WHERE card = ?').run(row.card)
    this.event(db, row, 'release', reason)
  }
  async ownerRelease(card: string, generation: number, reason: string) {
    return this.transaction(db => {
      const row = this.row(db, card)
      if (!this.active(row)) return { outcome: 'already-released' }
      if (row.generation !== generation) return { outcome: 'claim-changed', message: 'Holder changed; reload before releasing' }
      this.clear(db, row, reason)
      return { outcome: 'released', card_id: card }
    })
  }
}
