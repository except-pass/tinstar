import { randomUUID } from 'node:crypto'
import { CardContextReader } from '../reconciliation/cardContext'
import type { CardLeases } from '../reconciliation/cardLeases'
import type { ReconciliationConfig } from '../reconciliation/config'
import { notionObservation } from '../reconciliation/notion'
import { NotionApi } from '../reconciliation/notionApi'
import { WorkReader, type WorkCard } from '../reconciliation/workReader'
import { active, ClassificationCatalog, clean, eligible, fingerprint, label, requireBoard, type Catalog, type TaxonomyNotes } from './catalog'
import { assess, classifyCard, thresholds, type Classification } from './classify'
import { jevModel, OpenRouterJev } from './openRouter'

type Entry = { card: WorkCard; cohort: 'unassigned' | 'calibration' | 'holdout' }
export type DryRunRow = {
  cohort: Entry['cohort']
  expected: { initiative: string; epic: string } | null
  result: Classification
}
export type DryRun = {
  batchId: string
  catalog: Catalog
  activeCards: number
  historicalCards: number
  wallMs: number
  unassignedWallMs: number
  rows: DryRunRow[]
}

function publicResult(result: Classification) {
  if (result.state !== 'examined') return result
  const evidence = result.evidence
  return { ...result, evidence: {
    ...evidence,
    initiative: evidence.initiative && clean(evidence.initiative, 100),
    destination: evidence.destination && {
      initiative: clean(evidence.destination.initiative, 100), epic: evidence.destination.epic && clean(evidence.destination.epic, 100),
    },
  } }
}

class ClassificationLedger {
  constructor(private leases: CardLeases) {}
  start(batchId: string, sourceId: string | null, revision: string, entries: Entry[]) {
    const now = Date.now()
    return this.leases.writeStorage(db => {
      db.exec(`CREATE TABLE IF NOT EXISTS classification_jobs (
        batch_id TEXT NOT NULL, card_id TEXT NOT NULL, data_source_id TEXT, source_version TEXT NOT NULL,
        taxonomy_revision TEXT NOT NULL, requested_model TEXT NOT NULL, cohort TEXT NOT NULL,
        started_at INTEGER NOT NULL, state TEXT NOT NULL, result TEXT, write_receipt TEXT,
        PRIMARY KEY (batch_id, card_id)
      );`)
      // Keep recent evidence and bound total rows even if replays are frequent.
      db.prepare('DELETE FROM classification_jobs WHERE started_at < ?').run(now - 30 * 86_400_000)
      db.prepare(`DELETE FROM classification_jobs WHERE rowid IN (
        SELECT rowid FROM classification_jobs ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`).run(10_000 - entries.length)
      const insert = db.prepare(`INSERT INTO classification_jobs
        (batch_id, card_id, data_source_id, source_version, taxonomy_revision, requested_model, cohort, started_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      for (const { card, cohort } of entries) {
        insert.run(batchId, card.id, sourceId, card.last_edited_time, revision, jevModel, cohort, now)
      }
    })
  }
  finish(batchId: string, result: Classification) {
    return this.leases.writeStorage(db => {
      const payload = { ...publicResult(result), decision: assess(result, thresholds.conservative).outcome, finishedAt: Date.now() }
      db.prepare('UPDATE classification_jobs SET state = ?, result = ? WHERE batch_id = ? AND card_id = ?')
        .run(result.state, JSON.stringify(payload), batchId, result.cardId)
    })
  }
}

export class ClassificationService {
  private readonly board
  private readonly history
  private readonly reader
  private readonly context
  private readonly taxonomy
  private readonly ledger
  private running?: Promise<DryRun>

  constructor(private config: NonNullable<ReconciliationConfig['notion']>, private api: NotionApi,
    leases: CardLeases, private jev = new OpenRouterJev(), notes: TaxonomyNotes = {}) {
    this.board = notionObservation(config, api.parallelFetch, {}, api.backgroundFetch, true)
    this.history = notionObservation(config, api.parallelFetch, { statuses: ['Done', 'Archived'] }, api.backgroundFetch, true)
    this.reader = new WorkReader(config, api)
    this.context = new CardContextReader(config, api.parallelFetch)
    this.taxonomy = new ClassificationCatalog(notes)
    this.ledger = new ClassificationLedger(leases)
  }

  invalidateCatalog() {
    this.taxonomy.invalidate()
    this.api.invalidateSchema(this.config.dataSourceId)
  }

  dryRun(historicalLimit: number, onProgress?: (done: number, total: number) => void) {
    // Concurrent invocations in one backend share this read-only job.
    if (!this.running) {
      this.running = this.run(historicalLimit, onProgress).finally(() => { this.running = undefined })
    }
    return this.running
  }

  private async run(historicalLimit: number, onProgress?: (done: number, total: number) => void): Promise<DryRun> {
    const start = performance.now()
    const ask = await this.jev.open()
    const [boardObservation, historyObservation] = await Promise.all([
      this.board.get(true), historicalLimit ? this.history.get(true) : Promise.resolve(null),
    ])
    const board = requireBoard(boardObservation)
    const history = historyObservation ? requireBoard(historyObservation) : null
    const catalog = this.taxonomy.get(boardObservation)
    const activeCards = board.cards.filter(active)
    const cards = new Map([...history?.cards ?? [], ...board.cards].map(card => [card.id, card]))
    const activeIds = new Set(activeCards.map(card => card.id))
    // Stable card-ID ordering keeps a bounded sample independent of the model
    // and of Notion's default sorting. Only closed labels enter the calibration.
    const labeled = (history?.cards ?? []).filter(card => eligible(card) && !activeIds.has(card.id) &&
      label(card, 'Initiative') && label(card, 'Epic')).map(card => ({ card, order: fingerprint(card.id) }))
      .sort((left, right) => left.order.localeCompare(right.order))
    const entries: Entry[] = [
      ...activeCards.filter(card => !label(card, 'Initiative')).map(card => ({ card, cohort: 'unassigned' as const })),
      ...labeled.slice(0, historicalLimit).map(({ card, order }) => ({
        card, cohort: parseInt(order[0]!, 16) < 8 ? 'calibration' as const : 'holdout' as const,
      })),
    ]
    const batchId = randomUUID()
    await this.ledger.start(batchId, board.dataSourceId, catalog.revision, entries)
    const source = {
      parent: async (id: string) => cards.get(id) ?? this.reader.card(id),
      excerpt: (id: string) => this.context.classificationExcerpt(id),
    }
    const rows: DryRunRow[] = new Array(entries.length)
    const pendingUnassigned = entries.filter(entry => entry.cohort === 'unassigned').length
    let unassignedWallMs = pendingUnassigned ? 0 : Math.round(performance.now() - start)
    let next = 0, done = 0, doneUnassigned = 0
    const worker = async () => {
      for (let index = next++; index < entries.length; index = next++) {
        const { card, cohort } = entries[index]!
        const result = await classifyCard(card, catalog, source, ask, cohort === 'unassigned' ? 'work' : 'historical')
        await this.ledger.finish(batchId, result)
        const expected = cohort === 'unassigned' ? null : {
          initiative: label(card, 'Initiative')!, epic: label(card, 'Epic')!,
        }
        rows[index] = { cohort, expected, result }
        if (cohort === 'unassigned' && ++doneUnassigned === pendingUnassigned) unassignedWallMs = Math.round(performance.now() - start)
        onProgress?.(++done, entries.length)
      }
    }
    // The same bounded group limits both model inference and queued context reads.
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker))
    return { batchId, catalog, activeCards: activeCards.length, historicalCards: labeled.length,
      rows, wallMs: Math.round(performance.now() - start), unassignedWallMs }
  }
}
