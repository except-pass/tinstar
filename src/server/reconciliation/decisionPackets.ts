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
    return this.initialized ??= this.leases.writeStorage(db => {
      const oldKey = db.prepare("SELECT 1 FROM pragma_table_info('decision_card_answers') WHERE name = 'card' AND pk > 0").get()
      if (oldKey) db.exec('ALTER TABLE decision_card_answers RENAME TO decision_card_answers_previous')
      db.exec(`
        CREATE TABLE IF NOT EXISTS decision_card_packets (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, card TEXT NOT NULL, body TEXT NOT NULL,
          published_at TEXT NOT NULL, property_revision TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS decision_card_packet_lookup ON decision_card_packets(scope,card,invalidated);
        CREATE TABLE IF NOT EXISTS decision_card_answers (
          scope TEXT NOT NULL, card TEXT NOT NULL, caller TEXT NOT NULL, operation TEXT NOT NULL,
          binding TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, confirmed_at TEXT,
          PRIMARY KEY(scope,caller,operation)
        );`)
      if (!db.prepare("SELECT 1 FROM pragma_table_info('decision_card_packets') WHERE name = 'recovery_revision'").get()) {
        db.exec('ALTER TABLE decision_card_packets ADD COLUMN recovery_revision TEXT')
      }
      if (oldKey) db.exec(`
        INSERT INTO decision_card_answers SELECT * FROM decision_card_answers_previous;
        DROP TABLE decision_card_answers_previous;`)
      db.exec('CREATE INDEX IF NOT EXISTS decision_card_answer_lookup ON decision_card_answers(scope,card,state)')
    })
  }

  readInStorage(db: DatabaseSync, id: string): StoredDecisionPacket | null {
    const row = db.prepare('SELECT id,body,published_at FROM decision_card_packets WHERE scope = ? AND id = ?')
      .get(this.scope, id) as PacketRow | undefined
    if (!row) return null
    const packet = JSON.parse(row.body) as DecisionPacket
    packet.options = packet.options.map(({ id, label }) => ({ id, label }))
    return { id: row.id, packet, published_at: row.published_at }
  }

  currentInStorage(db: DatabaseSync, card: string, revision?: string): StoredDecisionPacket | null {
    const row = db.prepare('SELECT id FROM decision_card_packets WHERE scope = ? AND card = ? AND invalidated = 0')
      .get(this.scope, card) as { id: string } | undefined
    const stored = row ? this.readInStorage(db, row.id) : null
    return revision === undefined || stored?.packet.source_revision === revision ? stored : null
  }

  recoveryRevision(id: string) {
    return this.leases.readStorage(db => (db.prepare('SELECT recovery_revision FROM decision_card_packets WHERE scope = ? AND id = ?')
      .get(this.scope, id) as { recovery_revision: string | null } | undefined)?.recovery_revision)
  }

  answeredInStorage(db: DatabaseSync, card: string, revision: string) {
    return !!db.prepare(`
      SELECT 1 FROM decision_card_answers AS answer
      JOIN decision_card_packets AS packet ON packet.id = json_extract(answer.binding, '$.packet_id')
      WHERE answer.scope = ? AND answer.card = ? AND answer.state = 'recorded'
        AND (json_extract(packet.body, '$.source_revision') = ? OR json_extract(answer.binding, '$.settled_revision') = ?)`)
      .get(this.scope, card, revision, revision)
  }

  savingInStorage(db: DatabaseSync, card: string) {
    return !!db.prepare("SELECT 1 FROM decision_card_answers WHERE scope = ? AND card = ? AND state = 'saving'").get(this.scope, card)
  }

  claimableInStorage(db: DatabaseSync, card: WorkCard | string) {
    const id = typeof card === 'string' ? card : card.id
    const active = db.prepare('SELECT id,property_revision FROM decision_card_packets WHERE scope = ? AND card = ? AND invalidated = 0')
      .get(this.scope, id) as { id: string; property_revision: string } | undefined
    if (!active || typeof card !== 'string' && active.property_revision !== decisionPropertyRevision(card) ||
      this.savingInStorage(db, id) || this.leases.activeInStorage(this.leases.rowInStorage(db, id)) ||
      this.leases.reviewReservedInStorage(db, id)) return null
    return this.readInStorage(db, active.id)
  }

  publishInStorage(db: DatabaseSync, source: DecisionCardSource, contents: PacketContents): StoredDecisionPacket {
    const card_id = source.card.id
    if (this.savingInStorage(db, card_id) || this.answeredInStorage(db, card_id, source.revision)) {
      throw new DecisionDeskConflict('An answer is pending or recorded for this decision')
    }
    const prior = this.currentInStorage(db, card_id, source.revision)
    if (prior) return prior
    this.invalidateInStorage(db, card_id)
    const packet: DecisionPacket = { ...contents, card_id, source_revision: source.revision, title: source.title,
      options: contents.options.map((option, index) => ({ ...option, id: String(index + 1) })) }
    const id = randomUUID(), published_at = new Date(this.now()).toISOString()
    db.prepare('INSERT INTO decision_card_packets (id,scope,card,body,published_at,property_revision,recovery_revision) VALUES (?,?,?,?,?,?,?)')
      .run(id, this.scope, card_id, JSON.stringify(packet), published_at, source.propertyRevision, source.recoveryRevision)
    return { id, packet, published_at }
  }

  invalidateInStorage(db: DatabaseSync, card: string) {
    db.prepare('UPDATE decision_card_packets SET invalidated = 1 WHERE scope = ? AND card = ? AND invalidated = 0').run(this.scope, card)
  }

}
