import { createHash } from 'node:crypto'
import { z } from 'zod'
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

const credentialKey = String.raw`[_-]*(?:[\da-z]+[_-]+)*(?:password|passwd|token|api[_-]?key|secret|authorization)(?:[_-]+[\da-z]+)*[_-]*`
const quotedCredential = String.raw`(?:"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$))`
const omittedCredential = '[credential omitted]'
const closingPunctuation = String.raw`)\]}>,;:.!?"'”’`
const unquotedCredential = String.raw`\S*[^\s${closingPunctuation}]`
const authBoundary = String.raw`(?=$|[\s${closingPunctuation}])`
const bearerCredential = new RegExp(String.raw`\bbearer\s+[A-Za-z0-9._~+/-]{12,}(?<!\.)=*${authBoundary}`, 'gi')
const basicCredential = new RegExp(String.raw`\bbasic\s+([A-Za-z0-9+/]{12,}={0,2})${authBoundary}`, 'gi')
const knownCredential = new RegExp(
  String.raw`\b(?:(?:secret_|ntn_|sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}|xox[baprs]-[\w-]{10,}|AKIA[A-Z0-9]{16}|AIza[\w-]{30,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)(?:${unquotedCredential})?`,
  'g',
)
const sameLineSpace = String.raw`[^\S\r\n\u2028\u2029]`
const credentialValue = String.raw`(?:(?:(?:[Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc])${sameLineSpace}+)?${quotedCredential}|[^\r\n\u2028\u2029]*)`
const assignmentWithValue = (key: string, flags: string) =>
  new RegExp(String.raw`(?:${key})${sameLineSpace}*${credentialValue}`, flags)

const credentialAssignment = assignmentWithValue(
  String.raw`(?<![\w-])(?:${credentialKey}["']?${sameLineSpace}*[:=]|--${credentialKey}${sameLineSpace}+)`,
  'gi',
)
const legacyCredentialAssignment = assignmentWithValue(
  String.raw`\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|PASSWORD|SECRET)${sameLineSpace}*=`,
  'g',
)

function redactClassificationText(text: string) {
  return text
    .replace(/-----BEGIN (?:[^-\r\n]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[^-\r\n]+ )?PRIVATE KEY-----|$)/g, omittedCredential)
    .replace(credentialAssignment, omittedCredential)
    .replace(legacyCredentialAssignment, omittedCredential)
    .replace(bearerCredential, omittedCredential)
    .replace(basicCredential, (match, token: string) =>
      Buffer.from(token, 'base64').toString('latin1').includes(':') ? omittedCredential : match)
    .replace(knownCredential, omittedCredential)
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/https?:\/\/[^\s<>()]+/gi, '[link omitted]')
}

export function clean(text: unknown, limit: number) {
  const oneLine = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return redactClassificationText(oneLine).trim().slice(0, limit)
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
  get(observation: Observation<WorkData>) {
    const source = requireBoard(observation)
    if (this.cached?.source === source && this.cached.until > this.now()) return this.cached.catalog
    const catalog = buildCatalog(source, this.notes)
    this.cached = { source, catalog, until: this.now() + 60_000 }
    return catalog
  }
}
