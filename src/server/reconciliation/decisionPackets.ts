import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DecisionPacket, PacketContents } from '../../shared/decisionPacket'
import type { WorkCard } from './workReader'
import type { CardLeases } from './cardLeases'
import { decisionPropertyRevision, type DecisionCardSource } from './decisionEvidence'

export class DecisionDeskConflict extends Error {}
export interface StoredDecisionPacket {
  id: string
  packet: DecisionPacket
  published_at: string
}
type PacketRow = { id: string; body: string; published_at: string }

export class DecisionPackets {
  private initialized?: Promise<void>
  constructor(readonly leases: CardLeases, readonly scope: string, private now = Date.now) {}

  initialize() {
    return this.initialized ??= this.leases.writeStorage(db => db.exec(`
      CREATE TABLE IF NOT EXISTS decision_card_packets (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, card TEXT NOT NULL, body TEXT NOT NULL,
        published_at TEXT NOT NULL, property_revision TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS decision_card_packet_lookup ON decision_card_packets(scope,card,invalidated);
      CREATE TABLE IF NOT EXISTS decision_card_answers (
        scope TEXT NOT NULL, card TEXT NOT NULL, caller TEXT NOT NULL, operation TEXT NOT NULL,
        binding TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, confirmed_at TEXT,
        PRIMARY KEY(scope,card), UNIQUE(scope,caller,operation)
      );`))
  }

  readInStorage(db: DatabaseSync, id: string): StoredDecisionPacket | null {
    const row = db.prepare('SELECT id,body,published_at FROM decision_card_packets WHERE scope = ? AND id = ?')
      .get(this.scope, id) as PacketRow | undefined
    return row ? { id: row.id, packet: JSON.parse(row.body) as DecisionPacket, published_at: row.published_at } : null
  }

  currentInStorage(db: DatabaseSync, card: string, revision?: string): StoredDecisionPacket | null {
    const row = db.prepare('SELECT id FROM decision_card_packets WHERE scope = ? AND card = ? AND invalidated = 0')
      .get(this.scope, card) as { id: string } | undefined
    const stored = row ? this.readInStorage(db, row.id) : null
    return revision === undefined || stored?.packet.source_revision === revision ? stored : null
  }

  answeredInStorage(db: DatabaseSync, card: string) {
    if (db.prepare("SELECT 1 FROM decision_card_answers WHERE scope = ? AND card = ? AND state = 'recorded'").get(this.scope, card)) return true
    // Preserve completed answers from the former Desk across the upgrade.
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'decision_desk_confirmed_answers'").get() &&
      !!db.prepare('SELECT 1 FROM decision_desk_confirmed_answers WHERE scope = ? AND card = ? LIMIT 1').get(this.scope, card)
  }

  claimableInStorage(db: DatabaseSync, card: WorkCard | string) {
    const id = typeof card === 'string' ? card : card.id
    const active = db.prepare('SELECT id,property_revision FROM decision_card_packets WHERE scope = ? AND card = ? AND invalidated = 0')
      .get(this.scope, id) as { id: string; property_revision: string } | undefined
    if (!active || typeof card !== 'string' && active.property_revision !== decisionPropertyRevision(card) ||
      this.answeredInStorage(db, id) || db.prepare('SELECT 1 FROM decision_card_answers WHERE scope = ? AND card = ?').get(this.scope, id) ||
      this.leases.activeInStorage(this.leases.rowInStorage(db, id)) || this.leases.reviewReservedInStorage(db, id)) return null
    return this.readInStorage(db, active.id)
  }

  publishInStorage(db: DatabaseSync, source: DecisionCardSource, contents: PacketContents): StoredDecisionPacket {
    const card_id = source.card.id
    const prior = this.currentInStorage(db, card_id, source.revision)
    if (prior) return prior
    this.invalidateInStorage(db, card_id)
    const packet: DecisionPacket = { ...contents, card_id, source_revision: source.revision, title: source.title,
      options: contents.options.map((option, index) => ({ ...option, id: String(index + 1) })) }
    const id = randomUUID(), published_at = new Date(this.now()).toISOString()
    db.prepare('INSERT INTO decision_card_packets (id,scope,card,body,published_at,property_revision) VALUES (?,?,?,?,?,?)')
      .run(id, this.scope, card_id, JSON.stringify(packet), published_at, source.propertyRevision)
    return { id, packet, published_at }
  }

  invalidateInStorage(db: DatabaseSync, card: string) {
    db.prepare('UPDATE decision_card_packets SET invalidated = 1 WHERE scope = ? AND card = ? AND invalidated = 0').run(this.scope, card)
  }

}
