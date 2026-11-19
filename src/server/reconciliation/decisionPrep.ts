import { refillSize } from '../../shared/decisionDeskQueue'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { packetContents } from '../../shared/decisionPacket'
import { redactSourceText } from '../../shared/searchDocuments'
import { cardSourceUrl } from '../../shared/workIdentity'
import { DecisionDeskConflict, type DecisionPackets } from './decisionPackets'
import type { DecisionCardSource } from './decisionEvidence'
import type { WorkCard } from './workReader'

const exec = promisify(execFile)
const retryAfter = 15 * 60_000
/** A second send covers one lost packet. Further sends of an unchanged revision are how the same card was posted every 15 minutes. */
export const prepSendCap = 2
export const prepCapStop = 'Preparation stopped after 2 sends for this revision. It sends again when the open request or source revision changes.'
export const prepIneligibleStop = 'Preparation stopped because this card is no longer an open owner decision.'
const prepRevisionStop = 'Preparation stopped because the open request or source revision changed.'
export const prepSecretName = 'grok/tinstar-decision-prep'
export const preparerName = 'Tinstar Decision Prep'
const webhookMissing = 'The preparer webhook is not configured.'

export const publishPacketInput = z.object({ job_id: z.string().uuid(), packet: packetContents })
interface Job { id: string; card: string; revision: string; state: 'sending' | 'sent' | 'failed' | 'stopped' | 'published'; at: number; packet_id: string | null; message: string | null }
type Secret = { url: string; key: string }

/** Read one Clavis bundle as JSON. Failures and empty results are absence; stdout is never logged. */
export async function readClavisValue(name: string): Promise<string | null> {
  try {
    const { stdout } = await exec('clavis', ['get', name, '--format=json'], { timeout: 15_000, encoding: 'utf8', maxBuffer: 8192 })
    const value = stdout.trim()
    return value || null
  } catch { return null }
}

function prepSecret(raw: string | null): Secret | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const url = webhookUrl(typeof record.url === 'string' ? record.url : '')
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  return url && key ? { url, key } : null
}

function webhookUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch { return null }
}

/** One push job per card. The job ID gives the publisher the card context;
 * packet metadata and option IDs are always assigned here. */
export class DecisionPreparation {
  private initialized?: Promise<void>
  private secret: Secret | null = null
  private loadedAt = -Infinity
  private pending?: Promise<void>
  private explanation = webhookMissing
  private refreshCursor = 0
  private candidateCursor = 0

  constructor(readonly packets: DecisionPackets, private source: {
    refreshQueue(): Promise<WorkCard[]>
    read(card: string, background: boolean): Promise<DecisionCardSource>
    exclusive<T>(card: string, perform: () => Promise<T>): Promise<T>
  }, private readSecret = readClavisValue, private fetcher: typeof fetch = fetch, private now = Date.now) {}

  private initialize() {
    return this.initialized ??= this.packets.initialize().then(() => this.packets.leases.writeStorage(db => db.exec(`
      CREATE TABLE IF NOT EXISTS decision_card_prep (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, card TEXT NOT NULL, revision TEXT NOT NULL,
        state TEXT NOT NULL, at INTEGER NOT NULL, packet_id TEXT, message TEXT
      );
      CREATE INDEX IF NOT EXISTS decision_card_prep_lookup ON decision_card_prep(scope,state,card,at);`)))
  }

  private get scope() { return this.packets.scope }

  async status() {
    await this.initialize()
    const jobs = this.packets.leases.readStorage(db => db.prepare(
      'SELECT id,card,revision,state,at,packet_id,message FROM decision_card_prep WHERE scope = ? ORDER BY at DESC LIMIT 100',
    ).all(this.scope) as unknown as Job[])
    return { configured: !!this.secret, preparer: preparerName, explanation: this.explanation, jobs,
      preparing: jobs.filter(job => job.state === 'sending' || job.state === 'sent').length }
  }

  replenish(): Promise<void> {
    return this.pending ??= this.refill().catch(() => {
      this.explanation = 'Could not refresh the decision queue. The next pass will retry.'
    }).finally(() => { this.pending = undefined })
  }

  private held(db: DatabaseSync, card: string) {
    return !!this.packets.currentInStorage(db, card) || this.packets.savingInStorage(db, card) ||
      !!this.packets.leases.activeInStorage(this.packets.leases.rowInStorage(db, card))
  }

  private sendCount(db: DatabaseSync, card: string, revision: string) {
    return (db.prepare('SELECT count(*) AS count FROM decision_card_prep WHERE scope = ? AND card = ? AND revision = ?')
      .get(this.scope, card, revision) as { count: number }).count
  }

  private recentAttempt(db: DatabaseSync, card: string, revision: string, cutoff: number) {
    return !!db.prepare("SELECT 1 FROM decision_card_prep WHERE scope = ? AND card = ? AND revision = ? AND state IN ('sending','sent','failed') AND at > ?")
      .get(this.scope, card, revision, cutoff)
  }

  private stopCard(db: DatabaseSync, card: string, message: string) {
    db.prepare("UPDATE decision_card_prep SET state = 'stopped', message = ? WHERE scope = ? AND card = ? AND state IN ('sending','sent','failed')")
      .run(message, this.scope, card)
  }

  private noteCap(db: DatabaseSync, card: string, revision: string, cutoff: number) {
    const inFlight = db.prepare("SELECT 1 FROM decision_card_prep WHERE scope = ? AND card = ? AND revision = ? AND state IN ('sending','sent') AND at > ?")
      .get(this.scope, card, revision, cutoff)
    if (inFlight) return
    const latest = db.prepare("SELECT id, message FROM decision_card_prep WHERE scope = ? AND card = ? AND revision = ? AND state != 'published' ORDER BY at DESC LIMIT 1")
      .get(this.scope, card, revision) as { id: string; message: string | null } | undefined
    if (latest && latest.message !== prepCapStop) db.prepare('UPDATE decision_card_prep SET state = ?, message = ? WHERE id = ?').run('stopped', prepCapStop, latest.id)
  }

  /** Expired attempts may be retried once. The second unanswered attempt stops instead of being posted again. */
  private expireJobs(db: DatabaseSync, cutoff: number) {
    const rows = db.prepare("SELECT id, card, revision FROM decision_card_prep WHERE scope = ? AND state IN ('sending','sent') AND at <= ?")
      .all(this.scope, cutoff) as unknown as Array<{ id: string; card: string; revision: string }>
    const update = db.prepare('UPDATE decision_card_prep SET state = ?, message = ? WHERE id = ?')
    for (const row of rows) {
      const capped = this.sendCount(db, row.card, row.revision) >= prepSendCap
      update.run(capped ? 'stopped' : 'failed', capped ? prepCapStop : 'No packet received; retrying preparation', row.id)
    }
  }

  private refillCapacity(db: DatabaseSync, queue: WorkCard[], cutoff: number) {
    const { count } = db.prepare("SELECT count(*) AS count FROM decision_card_prep WHERE scope = ? AND state IN ('sending','sent') AND at > ?")
      .get(this.scope, cutoff) as { count: number }
    if (count >= refillSize || queue.filter(card => this.packets.claimableInStorage(db, card)).length >= refillSize) return 0
    return refillSize - count
  }

  private async refill() {
    await this.initialize()
    if (this.now() - this.loadedAt >= 30_000) {
      this.loadedAt = this.now()
      this.secret = prepSecret(await this.readSecret(prepSecretName))
    }
    const queue = await this.source.refreshQueue()
    const cutoff = this.now() - retryAfter
    const { candidates, prepared, openCards } = await this.packets.leases.writeStorage(db => {
      this.expireJobs(db, cutoff)
      const prepared = queue.filter(card => this.packets.currentInStorage(db, card.id))
      const capacity = this.secret ? this.refillCapacity(db, queue, cutoff) : 0
      const openCards = (db.prepare("SELECT DISTINCT card FROM decision_card_prep WHERE scope = ? AND state IN ('sending','sent','failed')")
        .all(this.scope) as unknown as Array<{ card: string }>).map(row => row.card)
      // A failed attempt still inside the 15-minute gap is not due, and it must not take a slot from a card that is.
      const recent = new Set((db.prepare("SELECT card FROM decision_card_prep WHERE scope = ? AND state IN ('sending','sent','failed') AND at > ?")
        .all(this.scope, cutoff) as unknown as Array<{ card: string }>).map(row => row.card))
      const fresh = capacity ? queue.filter(card => !recent.has(card.id) && !this.held(db, card.id)) : []
      const first = fresh.length ? this.candidateCursor % fresh.length : 0
      const selected = [...fresh.slice(first), ...fresh.slice(0, first)].slice(0, capacity)
      return { candidates: selected, prepared, openCards }
    })
    if (prepared.length) {
      const index = this.refreshCursor % prepared.length
      this.refreshCursor += Math.min(4, prepared.length)
      // Read a rotating subset of published cards so discussion changes are
      // discovered even in the absence of a claim. Failed reads keep the packet.
      const refresh = [...prepared.slice(index), ...prepared.slice(0, index)].slice(0, 4)
      await Promise.allSettled(refresh.map(card => this.source.read(card.id, true)))
    }
    const secret = this.secret
    if (!secret) { this.explanation = webhookMissing; return }
    const ids = [...new Set([...candidates.map(card => card.id), ...openCards])]
    const sources = await Promise.allSettled(ids.map(id => this.source.read(id, true)))
    const jobs = await this.packets.leases.writeStorage(db => {
      const cutoff = this.now() - retryAfter
      const sendable = sources.flatMap(result => {
        if (result.status !== 'fulfilled') return []
        const source = result.value, card = source.card.id
        if (!source.prepEligible) { this.stopCard(db, card, prepIneligibleStop); return [] }
        db.prepare("UPDATE decision_card_prep SET state = 'stopped', message = ? WHERE scope = ? AND card = ? AND revision != ? AND state IN ('sending','sent','failed')")
          .run(prepRevisionStop, this.scope, card, source.revision)
        if (this.held(db, card) || this.packets.answeredInStorage(db, card, source.revision)) return []
        if (this.sendCount(db, card, source.revision) >= prepSendCap) { this.noteCap(db, card, source.revision, cutoff); return [] }
        if (this.recentAttempt(db, card, source.revision, cutoff)) return []
        return [source]
      })
      const capacity = this.refillCapacity(db, queue, cutoff)
      const insert = db.prepare("INSERT INTO decision_card_prep (id,scope,card,revision,state,at) VALUES (?,?,?,?,'sending',?)")
      return sendable.slice(0, capacity).map(source => {
        const id = randomUUID()
        insert.run(id, this.scope, source.card.id, source.revision, this.now())
        return { id, source }
      })
    })
    const freshIds = new Set(candidates.map(card => card.id))
    const sentFresh = jobs.filter(job => freshIds.has(job.source.card.id)).length
    if (sentFresh < candidates.length) this.candidateCursor += candidates.length - sentFresh
    const results = await Promise.all(jobs.map(job => this.push(secret, job.id, job.source)))
    const failures = results.filter(Boolean)
    this.explanation = failures.length ? `${failures.length} of ${jobs.length} jobs could not be sent. ${failures[0]}` :
      jobs.length ? `Sent ${jobs.length} cards to the preparer.` :
      sources.some(result => result.status === 'rejected') ? 'Some card reads failed. The next pass will retry.' : 'Tops up to 10 outstanding jobs when fewer than 10 cards are ready.'
  }

  private async push(secret: Secret, id: string, source: DecisionCardSource) {
    const payload = {
      card_url: cardSourceUrl(source.card.id),
      source_question: redactSourceText(source.question),
      source_revision: source.revision,
      publish: { tool: 'publish_prepared_packet', job_id: id },
    }
    let message: string | null = null
    try {
      const response = await this.fetcher(secret.url, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret.key}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) })
      await response.body?.cancel().catch(() => {})
      if (!response.ok) message = `Preparer webhook returned HTTP ${response.status}.`
    } catch { message = 'Preparer webhook could not be reached.' }
    await this.packets.leases.writeStorage(db => db.prepare(
      "UPDATE decision_card_prep SET state = ?, message = ? WHERE id = ? AND state = 'sending'",
    ).run(message ? 'failed' : 'sent', message, id))
    return message
  }

  async publish(input: unknown) {
    const { job_id, packet } = publishPacketInput.parse(input)
    await this.initialize()
    const lookup = () => this.packets.leases.readStorage(db => db.prepare(
      'SELECT id,card,revision,state,at,packet_id,message FROM decision_card_prep WHERE scope = ? AND id = ?',
    ).get(this.scope, job_id) as unknown as Job | undefined)
    const job = lookup()
    if (!job) throw new DecisionDeskConflict('job_id is unavailable')
    return this.source.exclusive(job.card, async () => {
      const current = lookup()!
      if (current.packet_id) return { outcome: 'published', job_id, packet_id: current.packet_id }
      const source = await this.source.read(current.card, false)
      if (source.revision !== current.revision || !source.prepEligible) {
        const changed = source.revision !== current.revision
        await this.packets.leases.writeStorage(db => {
          db.prepare("UPDATE decision_card_prep SET state = 'stopped', message = ? WHERE id = ? AND packet_id IS NULL")
            .run(changed ? 'Card changed while preparing' : prepIneligibleStop, job_id)
        })
        throw new DecisionDeskConflict(changed ? 'The card changed while preparing it' : 'This card is no longer an open owner decision')
      }
      return this.packets.leases.writeStorage(db => {
        const latest = db.prepare('SELECT packet_id,at FROM decision_card_prep WHERE scope = ? AND id = ?').get(this.scope, job_id) as Pick<Job, 'packet_id' | 'at'>
        if (latest.packet_id) return { outcome: 'published', job_id, packet_id: latest.packet_id }
        if (latest.at <= this.now() - retryAfter) throw new DecisionDeskConflict('The preparation job expired')
        const stored = this.packets.publishInStorage(db, source, packet)
        db.prepare("UPDATE decision_card_prep SET state = 'published', packet_id = ?, message = NULL WHERE id = ?").run(stored.id, job_id)
        return { outcome: 'published', job_id, packet_id: stored.id }
      })
    })
  }
}
