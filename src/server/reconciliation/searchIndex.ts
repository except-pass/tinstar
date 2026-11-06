import type { FloorScene } from '../../shared/reconciliationPresentation'
import { boundSearchDocuments, sceneSearchDocuments, searchText, type SearchIndexRead } from '../../shared/searchDocuments'

interface Prose { outcome: string; observedAt?: string; blocks?: Array<{ text: string }> }

/** Bounded opportunistic body enrichment. A scene read never waits for Notion
 * prose. Metadata stays searchable when enrichment fails or is still pending. */
export class SearchDocumentCollector {
  private prose = new Map<string, { version: string; result: Prose }>()
  private pending = new Set<string>()
  private retryAt = new Map<string, number>()
  private nextBatchAt = 0
  private cursor = 0
  constructor(private readonly read: (id: string, revision: string) => Promise<Prose>, private readonly now = Date.now) {}

  get(scene: FloorScene): SearchIndexRead {
    const authorized = new Set(scene.cards.map(card => card.id))
    for (const id of this.prose.keys()) if (!authorized.has(id)) { this.prose.delete(id); this.retryAt.delete(id) }
    if (this.now() >= this.nextBatchAt && !this.pending.size && scene.coverage.intentions.status === 'fresh') {
      this.nextBatchAt = this.now() + 20_000
      const cards = scene.cards.filter(card => !card.source.in_trash)
      let budget = 4
      const start = this.cursor % Math.max(1, cards.length)
      for (let offset = 0; offset < cards.length && budget > 0; offset++) {
        const index = (start + offset) % cards.length, card = cards[index]!
        const cached = this.prose.get(card.id)
        if (cached?.version === card.source.last_edited_time && cached.result.outcome !== 'unavailable' || this.now() < (this.retryAt.get(card.id) ?? 0)) continue
        budget--; this.cursor = (index + 1) % cards.length; this.pending.add(card.id)
        this.retryAt.set(card.id, this.now() + 60_000)
        void this.read(card.id, card.source.last_edited_time).then(result => {
          this.prose.set(card.id, { version: card.source.last_edited_time, result })
        }).catch(() => {
          // Keep the previous text labeled stale when a refresh fails.
        }).finally(() => { this.pending.delete(card.id) })
      }
    }
    const documents = sceneSearchDocuments(scene)
    let ready = 0, partial = 0
    for (const document of documents) {
      if (document.target.kind !== 'card') continue
      const card = scene.cards.find(card => card.id === document.target.id)!
      const cached = this.prose.get(card.id)
      if (!cached || !['available', 'partial'].includes(cached.result.outcome)) continue
      const current = cached.version === card.source.last_edited_time
      const text = searchText(cached.result.blocks?.map(block => block.text).join('\n'))
      // Bodies are assigned their own field and provenance, never mistaken for
      // the full source or comments. Version changes retain labeled old text.
      if (text) document.fields.push({ name: current ? 'Description / card prose' : 'Description / last-known prose (stale)', source: `Notion blocks · ${cached.result.observedAt ?? 'time unknown'}`, text })
      if (current && cached.result.outcome === 'available') ready++; else partial++
    }
    const result = boundSearchDocuments(documents)
    result.notes.push(`Card prose: ${ready} available, ${partial} partial/stale, ${scene.cards.length - ready - partial} unavailable or pending. Background reads are bounded to four cards per refresh.`,
      'Comments, raw logs and transcripts are not indexed. PR titles and historical errors are searchable only when present in published fields.')
    return result
  }
}
