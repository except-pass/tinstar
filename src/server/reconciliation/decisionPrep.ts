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
const callbackStates = ['sending', 'sent', 'failed']
const callbackStateSql = `state IN (${callbackStates.map(state => `'${state}'`).join(',')})`
const liveJobSql = `${callbackStateSql} AND at > ?`

export function isLivePreparation(job: Pick<Job, 'state' | 'at'>, now: number) {
  return callbackStates.includes(job.state) && job.at > now - retryAfter
}

function requireLivePreparation(job: Pick<Job, 'state' | 'at'>, cutoff: number) {
  if (job.at <= cutoff) throw new DecisionDeskConflict('The preparation job expired')
  if (!callbackStates.includes(job.state)) throw new DecisionDeskConflict('The preparation job stopped')
}
/** A second send covers one lost packet. Further sends of an unchanged revision are how the same card was posted every 15 minutes. */
export const prepSendCap = 2
export const prepSecretName = 'grok/tinstar-decision-prep'
export const preparerName = 'Tinstar Decision Prep'
const webhookMissing = 'The preparer webhook is not configured.'

export const publishPacketInput = z.object({ job_id: z.string().uuid(), packet: packetContents })
interface Job { id: string; card: string; revision: string; state: 'sending' | 'sent' | 'failed' | 'expired' | 'stopped' | 'published'; at: number; packet_id: string | null; message: string | null }
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
      CREATE INDEX IF NOT EXISTS decision_card_prep_lookup ON decision_card_prep(scope,state,card,at);
      CREATE INDEX IF NOT EXISTS decision_card_prep_card_history ON decision_card_prep(scope,card,at);`)))
  }

  private get scope() { return this.packets.scope }

  async status() {
    await this.initialize()
    return this.packets.leases.readStorage(db => {
      const jobs = db.prepare(
        'SELECT id,card,revision,state,at,packet_id,message FROM decision_card_prep WHERE scope = ? ORDER BY at DESC LIMIT 100',
      ).all(this.scope) as unknown as Job[]
      return { configured: !!this.secret, preparer: preparerName, explanation: this.explanation, jobs,
        preparing: this.liveCount(db, this.now() - retryAfter) }
    })
  }

  hasJobHistoryInStorage(db: DatabaseSync, card: string) {
    return !!db.prepare('SELECT 1 FROM decision_card_prep WHERE scope = ? AND card = ? LIMIT 1').get(this.scope, card)
  }

  latestJobInStorage(db: DatabaseSync, card: string, revision: string) {
    return db.prepare('SELECT state,message,at FROM decision_card_prep WHERE scope = ? AND card = ? AND revision = ? ORDER BY at DESC, rowid DESC LIMIT 1')
      .get(this.scope, card, revision) as Pick<Job, 'state' | 'message' | 'at'> | undefined
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

  private hasLiveJob(db: DatabaseSync, card: string, cutoff: number) {
    return !!db.prepare(`SELECT 1 FROM decision_card_prep WHERE scope = ? AND card = ? AND ${liveJobSql}`)
      .get(this.scope, card, cutoff)
  }

  private expireJobs(db: DatabaseSync, cutoff: number) {
    const rows = db.prepare(`SELECT id, card, revision FROM decision_card_prep
      WHERE scope = ? AND ${callbackStateSql} AND at <= ?`).all(this.scope, cutoff) as unknown as Pick<Job, 'id' | 'card' | 'revision'>[]
    const update = db.prepare('UPDATE decision_card_prep SET state = ?, message = COALESCE(?, message) WHERE id = ?')
    for (const row of rows) {
      const capped = this.sendCount(db, row.card, row.revision) >= prepSendCap
      update.run(capped ? 'stopped' : 'expired', capped ? 'Preparation stopped after two sends without a packet' : null, row.id)
    }
  }

  private liveCount(db: DatabaseSync, cutoff: number) {
    return (db.prepare(`SELECT count(*) AS count FROM decision_card_prep WHERE scope = ? AND ${liveJobSql}`)
      .get(this.scope, cutoff) as { count: number }).count
  }

  private refillCapacity(db: DatabaseSync, queue: WorkCard[], cutoff: number) {
    const count = this.liveCount(db, cutoff)
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
    const { candidates, prepared, liveCards } = await this.packets.leases.writeStorage(db => {
      this.expireJobs(db, cutoff)
      const prepared = queue.filter(card => this.packets.currentInStorage(db, card.id))
      const capacity = this.secret ? this.refillCapacity(db, queue, cutoff) : 0
      const liveCards = (db.prepare(`SELECT DISTINCT card FROM decision_card_prep WHERE scope = ? AND ${liveJobSql}`)
        .all(this.scope, cutoff) as unknown as Array<{ card: string }>).map(row => row.card)
      const liveIds = new Set(liveCards)
      const fresh = capacity ? queue.filter(card => !liveIds.has(card.id) && !this.held(db, card.id)) : []
      const first = fresh.length ? this.candidateCursor % fresh.length : 0
      const selected = [...fresh.slice(first), ...fresh.slice(0, first)].slice(0, capacity)
      return { candidates: selected, prepared, liveCards }
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
    const candidateIds = new Set(candidates.map(card => card.id))
    const ids = [...new Set([...liveCards, ...candidateIds])]
    const attempts = await Promise.allSettled(ids.map(async id => {
      const dispatch = await this.source.exclusive(id, async () => {
        const source = await this.source.read(id, true)
        const job = await this.packets.leases.writeStorage(db => {
          const cutoff = this.now() - retryAfter
          db.prepare(`UPDATE decision_card_prep SET state = 'stopped', message = NULL
            WHERE scope = ? AND card = ? AND ${liveJobSql} AND (revision != ? OR ? = 0)`)
            .run(this.scope, id, cutoff, source.revision, Number(source.prepEligible))
          if (!secret || !candidateIds.has(id) || !source.prepEligible ||
            this.held(db, id) || this.packets.answeredInStorage(db, id, source.revision)) return
          if (!this.refillCapacity(db, queue, cutoff) || this.hasLiveJob(db, id, cutoff) ||
            this.sendCount(db, id, source.revision) >= prepSendCap) return
          const job = randomUUID()
          db.prepare("INSERT INTO decision_card_prep (id,scope,card,revision,state,at) VALUES (?,?,?,?,'sending',?)")
            .run(job, this.scope, id, source.revision, this.now())
          return job
        })
        return job && secret ? { completion: this.push(secret, job, source) } : undefined
      })
      return dispatch ? { message: await dispatch.completion } : undefined
    }))
    const sent = attempts.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
    this.candidateCursor += candidates.length - sent.length
    const failures = sent.flatMap(job => job.message ? [job.message] : [])
    this.explanation = !secret ? webhookMissing : failures.length ? `${failures.length} of ${sent.length} jobs could not be sent. ${failures[0]}` :
      sent.length ? `Sent ${sent.length} cards to the preparer.` :
      attempts.some(result => result.status === 'rejected') ? 'Some card reads failed. The next pass will retry.' : 'Tops up to 10 outstanding jobs when fewer than 10 cards are ready.'
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
      requireLivePreparation(current, this.now() - retryAfter)
      const source = await this.source.read(current.card, false)
      const changed = source.revision !== current.revision
      const packetId = await this.packets.leases.writeStorage(db => {
        const latest = db.prepare('SELECT packet_id,at,state FROM decision_card_prep WHERE scope = ? AND id = ?').get(this.scope, job_id) as Pick<Job, 'packet_id' | 'at' | 'state'>
        if (latest.packet_id) return latest.packet_id
        const cutoff = this.now() - retryAfter
        requireLivePreparation(latest, cutoff)
        if (changed || !source.prepEligible) {
          db.prepare(`UPDATE decision_card_prep SET state = 'stopped', message = ? WHERE id = ? AND ${liveJobSql}`)
            .run(changed ? 'Card changed while preparing' : null, job_id, cutoff)
          return null
        }
        const stored = this.packets.publishInStorage(db, source, packet)
        db.prepare("UPDATE decision_card_prep SET state = 'published', packet_id = ?, message = NULL WHERE id = ?").run(stored.id, job_id)
        return stored.id
      })
      if (!packetId) throw new DecisionDeskConflict(changed ? 'The card changed while preparing it' : 'This card is no longer an open owner decision')
      return { outcome: 'published', job_id, packet_id: packetId }
    })
  }
}
