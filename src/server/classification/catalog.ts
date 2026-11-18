import { createHash } from 'node:crypto'
import { z } from 'zod'
import { redactSourceText } from '../../shared/searchDocuments'
import type { Observation } from '../reconciliation/observation'
import type { WorkCard, WorkData } from '../reconciliation/workReader'

export type Destination = { initiative: string; epic: string | null }
const taxonomyScope = z.object({ scope: z.string().min(1).max(300).optional(), aliases: z.array(z.string().min(1).max(80)).max(5).optional() })
export const taxonomyNotes = z.object({
  initiatives: z.array(taxonomyScope.extend({ initiative: z.string(), initiativeOnly: z.boolean().optional() })).optional(),
  pairs: z.array(taxonomyScope.extend({ initiative: z.string(), epic: z.string() })).optional(),
}).strict()
export type TaxonomyNotes = z.infer<typeof taxonomyNotes>
type Description = { scope: string; aliases: string[]; areas: string[]; examples: string[] }
type Initiative = Description & { id: string; initiative: string }
type Pair = Description & Destination & { id: string }
export interface Catalog {
  revision: string
  initiativeOptions: string[]
  epicOptions: string[]
  initiatives: Initiative[]
  pairs: Pair[]
}

export const fingerprint = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex')
export const property = (card: WorkCard, name: string) => card.properties[name]?.value
export const label = (card: WorkCard, name: string) => {
  const value = property(card, name)
  return typeof value === 'string' && value ? value : null
}
export const pairKey = (initiative: string, epic: string | null) => JSON.stringify([initiative, epic])
export const eligible = (card: WorkCard) => !card.source && !card.archived && !card.in_trash
export const active = (card: WorkCard) => eligible(card) && !['Done', 'Archived'].includes(label(card, 'Status') ?? '')

export function clean(text: unknown, limit: number) {
  const prose = typeof text === 'string' ? text : ''
  return redactSourceText(prose
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[credential omitted]')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/^.*\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|PASSWORD|SECRET)\s*=.*$/gm, '[credential omitted]')
    .replace(/--(?:api[-_]key|token|password|secret)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '[credential omitted]')
    .replace(/https?:\/\/[^\s<>()]+/gi, '[link omitted]')
    .replace(/\b(?:xox[baprs]-[\w-]{10,}|AKIA[A-Z0-9]{16}|AIza[\w-]{30,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[credential omitted]'))
    .replace(/\s+/g, ' ').trim().slice(0, limit)
}

const unique = (values: string[]) => [...new Set(values)].sort()

function describe(cards: readonly WorkCard[], notes?: { scope?: string; aliases?: string[] }): Description {
  return {
    scope: clean(notes?.scope, 300),
    aliases: unique((notes?.aliases ?? []).map(value => clean(value, 80)).filter(Boolean)),
    areas: unique(cards.map(card => clean(property(card, 'Area'), 45)).filter(Boolean)).slice(0, 3),
    examples: unique(cards.map(card => clean(property(card, 'Name'), 85)).filter(Boolean)).slice(0, 3),
  }
}

export function requireBoard(observation: Observation<WorkData>): WorkData {
  const data = observation.data
  if (observation.status !== 'fresh' || observation.coverage !== 'complete' || !data || data.hasMore ||
    data.schema.Initiative?.type !== 'select' || data.schema.Epic?.type !== 'select') {
    throw new Error('Classification requires a fresh, complete Notion board with Initiative and Epic selects')
  }
  return data
}

function buildCatalog(data: WorkData, notes: TaxonomyNotes): Catalog {
  const initiativeOptions = unique(data.schema.Initiative!.options)
  const epicOptions = unique(data.schema.Epic!.options)
  const byInitiative = new Map<string, WorkCard[]>(), byPair = new Map<string, WorkCard[]>()
  for (const card of data.cards.filter(active)) {
    const initiative = label(card, 'Initiative'), epic = label(card, 'Epic')
    if (!initiative || !initiativeOptions.includes(initiative)) continue
    const initiativeCards = byInitiative.get(initiative) ?? []
    initiativeCards.push(card)
    byInitiative.set(initiative, initiativeCards)
    if (!epic || !epicOptions.includes(epic)) continue
    const key = pairKey(initiative, epic)
    const pairCards = byPair.get(key) ?? []
    pairCards.push(card)
    byPair.set(key, pairCards)
  }
  const initiatives = [...byInitiative.keys()].sort().map((initiative, index) => ({
    id: `initiative_${index + 1}`, initiative,
    ...describe(byInitiative.get(initiative)!, notes.initiatives?.find(option => option.initiative === initiative)),
  }))
  for (const note of notes.initiatives ?? []) {
    // A blank Epic is common during intake. Only explicit taxonomy notes can
    // make it an intentional final destination, and the initiative must be open.
    if (note.initiativeOnly && byInitiative.has(note.initiative)) {
      byPair.set(pairKey(note.initiative, null), byInitiative.get(note.initiative)!.filter(card => !label(card, 'Epic')))
    }
  }
  const pairs = [...byPair.keys()].sort().map((key, index) => {
    const [initiative, epic] = JSON.parse(key) as [string, string | null]
    return { id: `pair_${index + 1}`, initiative, epic,
      ...describe(byPair.get(key)!, notes.pairs?.find(option => option.initiative === initiative && option.epic === epic)) }
  })
  const catalog = { dataSourceId: data.dataSourceId, initiativeOptions, epicOptions, initiatives, pairs }
  return { ...catalog, revision: fingerprint(catalog) }
}

/** Lazy, short-lived cache over a board observation; no scheduled refresh. */
export class ClassificationCatalog {
  private cached?: { source: WorkData; catalog: Catalog; until: number }
  constructor(private notes: TaxonomyNotes = {}, private now = Date.now) {}
  invalidate() { this.cached = undefined }
  get(observation: Observation<WorkData>) {
    const source = requireBoard(observation)
    if (this.cached?.source === source && this.cached.until > this.now()) return this.cached.catalog
    const catalog = buildCatalog(source, this.notes)
    this.cached = { source, catalog, until: this.now() + 60_000 }
    return catalog
  }
}
