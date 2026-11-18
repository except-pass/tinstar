import { refillSize } from '../../shared/decisionDeskQueue'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { packetContents } from '../../shared/decisionPacket'
import { cardSourceUrl } from '../../shared/workIdentity'
import { DecisionDeskConflict, type DecisionPackets } from './decisionPackets'
import type { DecisionCardSource } from './decisionEvidence'
import type { WorkCard } from './workReader'

const exec = promisify(execFile)
const retryAfter = 10 * 60_000
export const prepSecretName = 'grok/tinstar-decision-prep'
export const preparerName = 'Tinstar Decision Prep'
const webhookMissing = 'The preparer webhook is not configured.'

export const publishPacketInput = z.object({ job_id: z.string().uuid(), packet: packetContents })
interface Job { id: string; card: string; revision: string; state: 'sending' | 'sent' | 'failed' | 'published'; at: number; packet_id: string | null; message: string | null }
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
    statusOptions(): string[]
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

  private async refill() {
    await this.initialize()
    if (this.now() - this.loadedAt >= 30_000) {
      this.loadedAt = this.now()
      this.secret = prepSecret(await this.readSecret(prepSecretName))
    }
    const queue = await this.source.refreshQueue()
    const cutoff = this.now() - retryAfter
    const { candidates, prepared } = await this.packets.leases.writeStorage(db => {
      db.prepare("UPDATE decision_card_prep SET state = 'failed', message = 'No packet received; retrying preparation' WHERE scope = ? AND state IN ('sending','sent') AND at <= ?")
        .run(this.scope, cutoff)
      const busy = !!db.prepare("SELECT 1 FROM decision_card_prep WHERE scope = ? AND state IN ('sending','sent')").get(this.scope)
      const retryLater = db.prepare("SELECT 1 FROM decision_card_prep WHERE scope = ? AND card = ? AND state = 'failed' AND at > ? LIMIT 1")
      const prepared = queue.filter(card => this.packets.currentInStorage(db, card.id))
      const ready = prepared.filter(card => this.packets.claimableInStorage(db, card)).length
      const candidates = !this.secret || busy || ready >= refillSize ? [] : queue.filter(card =>
        !this.packets.currentInStorage(db, card.id) && !this.packets.answeredInStorage(db, card.id) &&
        !this.packets.leases.activeInStorage(this.packets.leases.rowInStorage(db, card.id)) &&
        !retryLater.get(this.scope, card.id, cutoff))
      const first = candidates.length ? this.candidateCursor % candidates.length : 0
      const selected = [...candidates.slice(first), ...candidates.slice(0, first)].slice(0, refillSize)
      return { candidates: selected, prepared }
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
    const sources = await Promise.allSettled(candidates.map(card => this.source.read(card.id, true)))
    if (sources.some(result => result.status === 'rejected')) this.candidateCursor += refillSize
    const jobs = await this.packets.leases.writeStorage(db => {
      // Another backend may already have filled the buffer while we read Notion.
      if (db.prepare("SELECT 1 FROM decision_card_prep WHERE scope = ? AND state IN ('sending','sent')").get(this.scope) ||
          queue.filter(card => this.packets.claimableInStorage(db, card)).length >= refillSize) return []
      const insert = db.prepare("INSERT INTO decision_card_prep (id,scope,card,revision,state,at) VALUES (?,?,?,?,'sending',?)")
      return sources.flatMap(result => {
        if (result.status !== 'fulfilled') return []
        const source = result.value, card = source.card.id
        if (!source.actionable || this.packets.answeredInStorage(db, card) || this.packets.currentInStorage(db, card) ||
          this.packets.leases.activeInStorage(this.packets.leases.rowInStorage(db, card))) return []
        const id = randomUUID()
        insert.run(id, this.scope, card, source.revision, this.now())
        return [{ id, source }]
      })
    })
    const results = await Promise.all(jobs.map(job => this.push(secret, job.id, job.source)))
    const failures = results.filter(Boolean)
    this.explanation = failures.length ? `${failures.length} of ${jobs.length} jobs could not be sent. ${failures[0]}` :
      jobs.length ? `Sent ${jobs.length} cards to the preparer.` :
      sources.some(result => result.status === 'rejected') ? 'Some card reads failed. The next pass will retry.' : 'Refills with up to 10 cards when fewer than 10 are ready.'
  }

  private async push(secret: Secret, id: string, source: DecisionCardSource) {
    const payload = {
      card_url: cardSourceUrl(source.card.id),
      source_question: source.question,
      status_options: this.source.statusOptions(),
      publish: { tool: 'publish_prepared_packet', job_id: id,
        instructions: 'Send packet with summary, options [{label,next?}], recommendation and links [{label,url}]. Optional option next fields are status, owner, waiting_for, waiting_for_type and waiting_for_id. Use only a board status from status_options. Leave a field out to keep it. Use only the changes that follow from that option.' },
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
    if (job.packet_id) return { outcome: 'published', job_id, packet_id: job.packet_id }
    const source = await this.source.read(job.card, false)
    if (!source.actionable || source.revision !== job.revision) {
      await this.packets.leases.writeStorage(db => {
        db.prepare("UPDATE decision_card_prep SET state = 'failed', message = 'Card changed while preparing' WHERE id = ? AND packet_id IS NULL")
          .run(job_id)
      })
      throw new DecisionDeskConflict('The card changed while preparing it')
    }
    return this.packets.leases.writeStorage(db => {
      const current = db.prepare('SELECT packet_id FROM decision_card_prep WHERE scope = ? AND id = ?').get(this.scope, job_id) as { packet_id: string | null }
      if (current.packet_id) return { outcome: 'published', job_id, packet_id: current.packet_id }
      if (this.packets.answeredInStorage(db, job.card)) throw new DecisionDeskConflict('The card has already been answered')
      const stored = this.packets.publishInStorage(db, source, packet)
      db.prepare("UPDATE decision_card_prep SET state = 'published', packet_id = ?, message = NULL WHERE id = ?").run(stored.id, job_id)
      return { outcome: 'published', job_id, packet_id: stored.id }
    })
  }
}
