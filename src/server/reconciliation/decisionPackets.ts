import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { bindingMeaning, decisionMeaning, decisionPacketSchema, decisionPacketReady, defaultDecisionPolicy, decisionPolicyUpdateSchema, dependencyIdentity, validateDecisionPacket,
  decisionPolicyValuesSchema, type DecisionPacket, type DecisionPacketValidation, type DecisionDependency } from '../../shared/decisionPacket'
import { requestAnchor } from '../../shared/deskSource'
import { CardLeases } from './cardLeases'
import type { ObservedDecisionEvidence as DecisionEvidence } from './decisionEvidence'

export class DecisionDeskConflict extends Error {}
export interface StoredDecisionPacket { id: string; version: number; content_hash: string; prepared_by: string; published_at: string; expires_at: string | null; packet: DecisionPacket }
export interface StoredDecisionPolicy { scope: string; version: number; values: typeof defaultDecisionPolicy | z.infer<typeof decisionPolicyUpdateSchema>['values']; updated_by: string | null; updated_at: string | null }
type PacketRow = { id: string; version: number; content_hash: string; prepared_by: string; published_at: string; expires_at: string; body: string }
const unpack = (row: PacketRow): StoredDecisionPacket => ({ id: row.id, version: row.version, content_hash: row.content_hash, prepared_by: row.prepared_by, published_at: row.published_at, expires_at: null, packet: decisionPacketSchema.parse(JSON.parse(row.body)) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const packetContentHash = (packet: DecisionPacket) => hash(decisionMeaning({ ...packet, binding: JSON.parse(bindingMeaning(packet.binding)),
  references: [...packet.references].sort((a, b) => decisionMeaning(a).localeCompare(decisionMeaning(b))),
  dependencies: [...packet.dependencies].sort((a, b) => dependencyIdentity(a).localeCompare(dependencyIdentity(b))) }))

/** Immutable advisory packets and append-only attestations, never source
 * answers. No scheduler, preparation worker, source writer or claim path. */
export class DecisionPackets {
  private initialized?: Promise<void>
  constructor(readonly leases: CardLeases, private now = Date.now) {}
  initialize() {
    return this.initialized ??= this.leases.writeStorage(db => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS decision_packets (
          id TEXT PRIMARY KEY, source_key TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL,
          prepared_by TEXT NOT NULL, published_at TEXT NOT NULL, expires_at TEXT NOT NULL, body TEXT NOT NULL,
          publication_key TEXT NOT NULL UNIQUE, UNIQUE(source_key,version));
        CREATE TABLE IF NOT EXISTS decision_packet_dependencies (
          packet_id TEXT NOT NULL, kind TEXT NOT NULL, dependency_key TEXT NOT NULL, revision TEXT NOT NULL,
          PRIMARY KEY(packet_id,kind,dependency_key));
        CREATE INDEX IF NOT EXISTS decision_dependency_lookup ON decision_packet_dependencies(kind,dependency_key);
        CREATE TABLE IF NOT EXISTS decision_dependency_changes (
          kind TEXT NOT NULL, dependency_key TEXT NOT NULL, revision TEXT, invalidated_at TEXT NOT NULL,
          PRIMARY KEY(kind,dependency_key));
        CREATE TABLE IF NOT EXISTS decision_packet_events (
          sequence INTEGER PRIMARY KEY, packet_id TEXT, type TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS decision_packet_events_latest ON decision_packet_events(packet_id,sequence);
        CREATE TABLE IF NOT EXISTS decision_packet_validations (
          sequence INTEGER PRIMARY KEY, packet_id TEXT NOT NULL, valid INTEGER NOT NULL, valid_until TEXT, reasons TEXT NOT NULL,
          coverage TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS decision_validation_latest ON decision_packet_validations(packet_id,sequence);
        CREATE TABLE IF NOT EXISTS decision_desk_policy (
          scope TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL, updated_by TEXT, updated_at TEXT);
      `)
    })
  }
  private event(db: DatabaseSync, packetId: string | null, type: string, actor: string, detail: unknown) {
    return Number(db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?) RETURNING sequence').get(packetId, type, actor, new Date(this.now()).toISOString(), JSON.stringify(detail))!.sequence)
  }
  private attest(db: DatabaseSync, id: string, packet: DecisionPacket, evidence: DecisionEvidence, actor: string, onlyChanged = false) {
    const validation = validateDecisionPacket(packet, evidence, this.now())
    // A cache read predating a known semantic change cannot resurrect the old
    // packet. Expired evidence may be re-observed with unchanged meaning.
    for (const dependency of packet.dependencies) {
      const known = db.prepare('SELECT revision,invalidated_at FROM decision_dependency_changes WHERE kind = ? AND dependency_key = ?').get(dependency.kind, dependency.key) as { revision: string | null; invalidated_at: string } | undefined
      if (known?.revision && known.revision !== dependency.revision) validation.reasons.push(`A newer dependency revision is known: ${dependencyIdentity(dependency)}`)
      const current = evidence.requests.flatMap(request => request.dependencies).find(current => dependencyIdentity(current) === dependencyIdentity(dependency))
      if (known && !known.revision && (!current?.observed_at || Date.parse(current.observed_at) <= Date.parse(known.invalidated_at))) validation.reasons.push(`Dependency needs re-observation after invalidation: ${dependencyIdentity(dependency)}`)
    }
    if (validation.reasons.length) { validation.valid = false; validation.valid_until = null }
    const previous = onlyChanged ? this.latestValidation(db, id) : null
    if (previous && previous.source_version === evidence.source_version && previous.valid === validation.valid &&
      decisionMeaning(previous.reasons) === decisionMeaning(validation.reasons)) return validation
    const sequence = this.event(db, id, 'validation', actor, { ...validation, source_version: evidence.source_version })
    const coverage = evidence.requests.flatMap(request => request.dependencies).map(({ kind, key, status, coverage, observed_at, expires_at, renewal_until }) => ({ kind, key, status, coverage, observed_at, expires_at, renewal_until }))
    db.prepare('INSERT INTO decision_packet_validations VALUES(?,?,?,?,?,?)').run(sequence, id, Number(validation.valid), validation.valid_until, JSON.stringify(validation.reasons), JSON.stringify(coverage))
    return validation
  }
  async publish(input: unknown, evidence: DecisionEvidence, actor: string, operationId: string) {
    await this.initialize()
    return this.leases.writeStorage(db => this.publishInStorage(db, input, evidence, actor, operationId))
  }
  publishInStorage(db: DatabaseSync, input: unknown, evidence: DecisionEvidence, actor: string, operationId: string) {
    const packet = decisionPacketSchema.parse(input)
    z.string().trim().min(1).max(200).parse(actor); z.string().trim().min(1).max(128).parse(operationId)
    const publicationKey = JSON.stringify([actor, operationId]), contentHash = packetContentHash(packet)
    const previous = db.prepare('SELECT * FROM decision_packets WHERE publication_key = ?').get(publicationKey) as PacketRow | undefined
    if (previous) {
      if (previous.content_hash !== contentHash) throw new DecisionDeskConflict('Publication operation already used for different packet meaning')
      return { ...unpack(previous), validation: this.latestValidation(db, previous.id), replayed: true }
    }
    const sourceKey = JSON.stringify([packet.binding.card_id, packet.binding.source_request ? requestAnchor(packet.binding.source_request) : packet.binding.request_key, packet.binding.request_id])
    const version = Number((db.prepare('SELECT coalesce(max(version),0)+1 AS version FROM decision_packets WHERE source_key = ?').get(sourceKey) as { version: number }).version)
    // Keep the legacy SQLite deadline column readable by older binaries. It is
    // no longer an eligibility gate; the wire reports no packet expiry.
    const id = randomUUID(), publishedAt = new Date(this.now()).toISOString(), expiresAt = new Date(this.now() + packet.review_within_ms).toISOString()
    db.prepare('INSERT INTO decision_packets VALUES(?,?,?,?,?,?,?,?,?)').run(id, sourceKey, version, contentHash, actor, publishedAt, expiresAt, JSON.stringify(packet), publicationKey)
    for (const dependency of packet.dependencies) db.prepare('INSERT INTO decision_packet_dependencies VALUES(?,?,?,?)').run(id, dependency.kind, dependency.key, dependency.revision)
    this.event(db, id, 'publication', actor, { version, content_hash: contentHash, source_revision: packet.binding.source_revision })
    const validation = this.attest(db, id, packet, evidence, actor)
    return { id, version, content_hash: contentHash, prepared_by: actor, published_at: publishedAt, expires_at: null, packet, validation, replayed: false }
  }
  async validate(id: string, evidence: DecisionEvidence, actor: string, onlyChanged = false) {
    z.string().trim().min(1).max(200).parse(actor)
    await this.initialize()
    return this.leases.writeStorage(db => {
      const row = db.prepare('SELECT * FROM decision_packets WHERE id = ?').get(id) as PacketRow | undefined
      if (!row) throw new DecisionDeskConflict('Packet is unavailable')
      return this.attest(db, id, unpack(row).packet, evidence, actor, onlyChanged)
    })
  }
  private latestValidation(db: DatabaseSync, id: string): (DecisionPacketValidation & { source_version?: string }) | null {
    const event = db.prepare("SELECT type,detail FROM decision_packet_events WHERE packet_id = ? AND type IN ('validation','invalidation') ORDER BY sequence DESC LIMIT 1").get(id) as { type: string; detail: string } | undefined
    if (!event) return null
    const detail = JSON.parse(event.detail)
    return event.type === 'validation' ? detail : { valid: false, reasons: [detail.reason], valid_until: null }
  }
  /** A changed dependency only invalidates packets that actually relied on its
   * old meaning. Timestamps/collector ordering are not change triggers. */
  async invalidate(dependency: Pick<DecisionDependency, 'kind' | 'key'>, revision: string | null, cause: 'changed-request' | 'source-closure' | 'conflicting-answer' | 'pr-head' | 'critical-worker-state' | 'expired-evidence', actor: string) {
    await this.initialize()
    return this.leases.writeStorage(db => {
      db.prepare('INSERT OR REPLACE INTO decision_dependency_changes VALUES(?,?,?,?)').run(dependency.kind, dependency.key, revision, new Date(this.now()).toISOString())
      const rows = db.prepare('SELECT packet_id,revision FROM decision_packet_dependencies WHERE kind = ? AND dependency_key = ?').all(dependency.kind, dependency.key) as Array<{ packet_id: string; revision: string }>
      const ids = [...new Set(rows.filter(row => revision === null || row.revision !== revision).map(row => row.packet_id))]
      for (const id of ids) this.event(db, id, 'invalidation', actor, { reason: `Packet invalidated: ${cause}`, cause, dependency, revision })
      return ids
    })
  }
  async read(id: string, evidence?: DecisionEvidence) {
    await this.initialize()
    return this.leases.readStorage(db => this.readInStorage(db, id, evidence))
  }
  readInStorage(db: DatabaseSync, id: string, evidence?: DecisionEvidence) {
      const row = db.prepare('SELECT * FROM decision_packets WHERE id = ?').get(id) as PacketRow | undefined
      if (!row) return null
      const stored = unpack(row), attestation = this.latestValidation(db, id)
      // A validation of a superseded packet cannot put two revisions of the
      // same request back in the ready buffer.
      const latest = db.prepare('SELECT id FROM decision_packets WHERE source_key = (SELECT source_key FROM decision_packets WHERE id = ?) ORDER BY version DESC LIMIT 1').get(id) as { id: string }
      const lease = db.prepare('SELECT caller,expires FROM leases WHERE card = ?').get(stored.packet.binding.card_id) as { caller: string | null; expires: number } | undefined
      const current = evidence ? validateDecisionPacket(stored.packet, evidence, this.now()) : { valid: false, reasons: ['Current source evidence not supplied'], valid_until: null }
      const withdrawn = !!db.prepare("SELECT 1 FROM decision_packet_events WHERE packet_id = ? AND type IN ('research-requested','answer-confirmed') LIMIT 1").get(id)
      const validation: DecisionPacketValidation = { valid: !!attestation?.valid && current.valid && latest.id === id && !withdrawn,
        reasons: [...(attestation?.reasons ?? ['Packet has not been validated']), ...current.reasons, ...(latest.id !== id ? ['Packet is superseded'] : []), ...(withdrawn ? ['Packet withdrawn for research or durably answered'] : [])],
        // Attestation fixes packet meaning; current observations own freshness.
        // Its old deadline must not expire an unchanged, renewed dependency.
        valid_until: attestation?.valid ? current.valid_until : null }
      const pending = this.pendingAnswerInStorage(db, id)
      return { ...stored, validation, ...decisionPacketReady(validation, (!!lease?.caller && lease.expires > this.now()) || this.leases.reviewReservedInStorage(db, stored.packet.binding.card_id) || pending, this.now()) }
  }
  pendingAnswerInStorage(db: DatabaseSync, id: string) {
    const event = db.prepare("SELECT detail FROM decision_packet_events WHERE packet_id = ? AND type = 'answer-attempt' ORDER BY sequence DESC LIMIT 1").get(id) as { detail: string } | undefined
    return event ? ['saving', 'save-unconfirmed', 'blocked-recovery'].includes(JSON.parse(event.detail).state) : false
  }
  async ids(limit = 50) {
    await this.initialize()
    return this.leases.readStorage(db => (db.prepare('SELECT id FROM decision_packets ORDER BY published_at DESC,id LIMIT ?').all(Math.min(100, Math.max(1, Math.trunc(limit)))) as Array<{ id: string }>).map(row => row.id))
  }
  async events(after = 0, limit = 50) {
    await this.initialize()
    return this.leases.readStorage(db => db.prepare('SELECT * FROM decision_packet_events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, Math.min(100, Math.max(1, Math.trunc(limit)))))
  }
  private policy(db: DatabaseSync, scope: string): StoredDecisionPolicy {
    db.prepare('INSERT OR IGNORE INTO decision_desk_policy VALUES(?,0,?,NULL,NULL)').run(scope, JSON.stringify(defaultDecisionPolicy))
    const row = db.prepare('SELECT * FROM decision_desk_policy WHERE scope = ?').get(scope) as { scope: string; version: number; body: string; updated_by: string | null; updated_at: string | null }
    const { body, ...metadata } = row
    let values = decisionPolicyValuesSchema.parse(JSON.parse(body))
    // P1 inserted replenishment ON. That row must not dispatch after this step
    // ships. One audit marks the cutover; only a later explicit save turns it on.
    const shipped = (db.prepare("SELECT detail FROM decision_packet_events WHERE type = 'policy'").all() as Array<{ detail: string }>).some(event => {
      try { const detail = JSON.parse(event.detail); return detail.migration === 'replenishment-off' && detail.scope === scope } catch { return false }
    })
    if (!shipped) {
      if (values.automatic_replenishment) {
        values = { ...values, automatic_replenishment: false }
        db.prepare('UPDATE decision_desk_policy SET body = ? WHERE scope = ?').run(JSON.stringify(values), scope)
      }
      this.event(db, null, 'policy', 'decision-desk', { scope, version: row.version, values, migration: 'replenishment-off', reason: 'Shipped replenishment off until the owner turns it on from Preparation' })
    }
    return { ...metadata, values }
  }
  async recordEvent(actor: string, type: string, detail: unknown, packetId: string | null = null) {
    z.string().trim().min(1).max(200).parse(actor)
    z.string().trim().min(1).max(80).parse(type)
    await this.initialize()
    return this.leases.writeStorage(db => this.event(db, packetId, type, actor, detail))
  }
  policyInStorage(db: DatabaseSync, scope: string) { return this.policy(db, scope) }
  async readPolicy(scope: string) {
    z.string().trim().min(1).max(2048).parse(scope)
    await this.initialize()
    return this.leases.writeStorage(db => this.policy(db, scope))
  }
  async updatePolicy(scope: string, input: unknown, actor: string) {
    const update = decisionPolicyUpdateSchema.parse(input)
    z.string().trim().min(1).max(2048).parse(scope); z.string().trim().min(1).max(200).parse(actor)
    await this.initialize()
    return this.leases.writeStorage(db => {
      const previous = this.policy(db, scope)
      if (previous.version !== update.expected_version) throw new DecisionDeskConflict('Preparation policy changed; read current settings before saving')
      db.prepare('UPDATE decision_desk_policy SET version = ?,body = ?,updated_by = ?,updated_at = ? WHERE scope = ?').run(previous.version + 1, JSON.stringify(update.values), actor, new Date(this.now()).toISOString(), scope)
      this.event(db, null, 'policy', actor, { scope, version: previous.version + 1, values: update.values })
      return this.policy(db, scope)
    })
  }
}
