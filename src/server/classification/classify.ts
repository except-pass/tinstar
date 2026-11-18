import type { CardContextRead } from '../reconciliation/cardContext'
import type { WorkCard } from '../reconciliation/workReader'
import { clean, eligible, fingerprint, label, property, type Catalog, type Destination } from './catalog'
import { JevError, type ChoiceAnswer, type DecisionRequest, type JevResponse, type Question } from './openRouter'

export type AskJev = (request: DecisionRequest) => Promise<JevResponse>
export type ClassifierSource = {
  parent(id: string): Promise<WorkCard | undefined>
  excerpt(id: string): Promise<CardContextRead>
}
type Rank = { id: string; probability: number }
export type Evidence = {
  initiative: string | null
  destination: Destination | null
  initiativeRanks: Rank[]
  destinationRanks: Rank[]
  initiativeConfidence: number
  destinationConfidence: number
  initiativeFit: number
  epicFit: number
  ambiguous: number
  initiativeOnly: number | null
  parentConflict: boolean
  sourceComplete: boolean
  parentCount: number
  bodyAvailable: boolean
}
export type Classification = {
  cardId: string
  sourceVersion: string
  fingerprint?: string
  taxonomyRevision: string
  wallMs: number
} & (
  | { state: 'examined'; evidence: Evidence; telemetry: Omit<JevResponse, 'answers'> }
  | { state: 'skipped' | 'needs-review' | 'failed'; reason: string; httpStatus?: number }
)

const none = 'none'
const exampleKey = (value: string) => value.trim().toLowerCase()
function describeCandidate(candidate: Catalog['initiatives'][number] | Catalog['pairs'][number], title: string) {
  const epic = 'epic' in candidate ? candidate.epic : undefined
  const name = epic === undefined ? clean(candidate.initiative, 100)
    : epic === null ? `${clean(candidate.initiative, 100)} — intentionally initiative-only`
      : `${clean(candidate.initiative, 100)} / ${clean(epic, 100)}`
  const examples = candidate.examples.filter(example => exampleKey(example) !== exampleKey(title)).slice(0, 2)
  return [name, candidate.scope, candidate.aliases.length && `Also known as ${candidate.aliases.join(', ')}`,
    candidate.areas.length && `Areas ${candidate.areas.join(', ')}`, examples.length && `Examples: ${examples.join(' | ')}`].filter(Boolean).join('. ')
}

async function readParents(card: WorkCard, source: ClassifierSource) {
  const parents: WorkCard[] = []
  let complete = true
  const seen = new Set([card.id])
  const pending = [card]
  while (pending.length && parents.length < 5) {
    const child = pending.shift()!
    const prop = child.properties['Parent item']
    if (prop?.hasMore || prop?.type !== 'relation') complete = false
    if (!Array.isArray(prop?.value)) continue
    for (const id of prop.value as string[]) {
      if (id === card.id || parents.length >= 5) { complete = false; continue }
      if (seen.has(id)) continue
      seen.add(id)
      const parent = await source.parent(id).catch(() => undefined)
      if (!parent || !eligible(parent)) { complete = false; continue }
      parents.push(parent)
      pending.push(parent)
    }
  }
  if (pending.some(child => child.properties['Parent item']?.hasMore ||
    Array.isArray(property(child, 'Parent item')) && (property(child, 'Parent item') as string[]).some(id => !seen.has(id)))) complete = false
  return { parents, complete }
}

function openingProse(context: CardContextRead) {
  const snippets: string[] = []
  let size = 0
  for (const block of context.blocks) {
    // Coordination and generated logs are outside the classification brief.
    if (/^\s*(?:check[- ]?ins?|updates?|decision history|worker handoff|activity|audit log|comment log)\s*:?(?:\s*$|\n)/i.test(block.text)) break
    const snippet = clean(block.text.replace(/^\s*(?:initiative|epic)\s*:.*$/gim, ''), 450)
    if (!snippet) continue
    snippets.push(snippet)
    size += snippet.length
    if (size >= 1_050 || snippets.length >= 5) break
  }
  return snippets.join(' ').slice(0, 1_100)
}

const noul = (instructions: string, yes: string, no: string): Question => ({
  type: 'noul', instructions, criteria: { true: yes, false: no },
})
const fit = (subject: 'initiative' | 'epic') => noul(
  `Does any ${subject} in the supplied catalog substantively fit this work card?`,
  subject === 'initiative' ? 'At least one listed initiative clearly owns the actual work.' : 'At least one listed epic clearly covers the work within a substantively fitting initiative.',
  `The work needs a new ${subject}, is outside the listed scopes, or has too little evidence to substantiate a fit.`,
)
const ranks = (answer: ChoiceAnswer) => Object.entries(answer.probabilities)
  .map(([id, probability]) => ({ id, probability }))
  .sort((left, right) => right.probability - left.probability || Number(right.id === answer.choice) - Number(left.id === answer.choice))
  .slice(0, 3)

export async function classifyCard(card: WorkCard, catalog: Catalog, source: ClassifierSource, ask: AskJev,
  mode: 'work' | 'historical' = 'work'): Promise<Classification> {
  const started = performance.now()
  const timing = () => ({ wallMs: Math.round(performance.now() - started) })
  const base = { cardId: card.id, sourceVersion: card.last_edited_time, taxonomyRevision: catalog.revision }
  // Replay masks the two labels without mutating the card or the source.
  const initiative = mode === 'work' ? label(card, 'Initiative') : null
  const epic = mode === 'work' ? label(card, 'Epic') : null
  if (!eligible(card) || initiative && epic) return { ...base, ...timing(), state: 'skipped', reason: 'outside-scope-or-already-classified' }
  if (card.properties.Initiative?.type !== 'select' || card.properties.Epic?.type !== 'select') {
    return { ...base, ...timing(), state: 'needs-review', reason: 'classification-fields-unavailable' }
  }
  const destinations = catalog.pairs.filter(pair => (!initiative || initiative === pair.initiative) && (!epic || epic === pair.epic))
  const initiatives = catalog.initiatives.filter(option => (!initiative || initiative === option.initiative) &&
    (!epic || destinations.some(pair => pair.initiative === option.initiative)))
  if (!initiatives.length) return { ...base, ...timing(), state: 'needs-review', reason: 'no-existing-initiative' }

  const title = clean(property(card, 'Name'), 250)
  const [hierarchy, body] = await Promise.all([readParents(card, source), source.excerpt(card.id)])
  const brief = openingProse(body)
  const description = clean(property(card, 'Brief') ?? property(card, 'Description'), 500)
  const area = [clean(property(card, 'Area'), 100), clean(property(card, 'Sub-area'), 100)].filter(Boolean).join(' / ')
  const parentFacts = hierarchy.parents.map(parent => ({
    title: clean(property(parent, 'Name'), 120),
    initiative: clean(label(parent, 'Initiative'), 100),
    epic: clean(label(parent, 'Epic'), 100),
  }))
  const initiativeCriteria = Object.fromEntries(initiatives.map(candidate => [candidate.id, describeCandidate(candidate, title)]))
  const pairCriteria = Object.fromEntries(destinations.map(candidate => [candidate.id, describeCandidate(candidate, title)]))
  const state = {
    card: { title, description, area, brief },
    existing_classification: { initiative: clean(initiative, 100), epic: clean(epic, 100) },
    ancestors: parentFacts,
    // Questions are evaluated independently. Share a compact catalog so the
    // Noul judgments see the same destination names as the Choice questions.
    catalog: {
      initiatives: initiatives.map(candidate => clean(candidate.initiative, 100)),
      epics_by_initiative: Object.fromEntries(initiatives.map(candidate => [clean(candidate.initiative, 100),
        destinations.filter(pair => pair.initiative === candidate.initiative && pair.epic).map(pair => clean(pair.epic, 100))])),
    },
  }
  const questions: Record<string, Question> = {
    initiative: { type: 'choice', instructions: 'Choose the initiative with the strongest evidence of owning the card. Use the parent chain as supporting context. A child can belong to a different initiative.',
      criteria: { ...initiativeCriteria, [none]: 'No listed initiative is supported by the work.' } },
    initiative_fit: fit('initiative'),
    epic_fit: fit('epic'),
    ambiguous: noul('Is the work classification ambiguous even after considering the card and its hierarchy?',
      'The work supports competing destinations, conflicts with its hierarchy, or the available details leave the scope uncertain.',
      'The work gives clear evidence of its scope and has one plausible home, or clearly belongs outside the catalog.'),
  }
  if (destinations.length) questions.destination = {
    type: 'choice', instructions: 'Choose the existing initiative and epic pair that best covers the work. The same epic name under different initiatives denotes different destinations.',
    criteria: { ...pairCriteria, [none]: 'No listed pair fits, or there is insufficient evidence to choose one.' },
  }
  if (destinations.some(pair => pair.epic === null)) questions.initiative_only = noul(
    'Is this initiative-wide work that should remain intentionally outside all epics?',
    'The work belongs at initiative level and does not require a more specific epic.',
    'The work is epic-sized, an epic fits it, or an epic may be missing from the taxonomy.',
  )
  const input = fingerprint([card.id, card.last_edited_time, hierarchy.parents.map(parent => [parent.id, parent.last_edited_time]), state, catalog.revision])
  try {
    const { answers, ...telemetry } = await ask({ state, questions })
    const initiativeAnswer = answers.initiative as ChoiceAnswer
    const destinationAnswer = answers.destination as ChoiceAnswer | undefined
    const chosenInitiative = initiatives.find(candidate => candidate.id === initiativeAnswer.choice)
    const pair = destinations.find(candidate => candidate.id === destinationAnswer?.choice)
    const destination = pair ? { initiative: pair.initiative, epic: pair.epic } : null
    const parentConflict = hierarchy.parents.some(parent => {
      const parentInitiative = label(parent, 'Initiative'), parentEpic = label(parent, 'Epic')
      return parentInitiative && chosenInitiative && parentInitiative !== chosenInitiative.initiative ||
        parentEpic && pair?.epic && parentEpic !== pair.epic
    })
    const probability = (key: string) => {
      const answer = answers[key]
      return answer?.type === 'noul' ? answer.noul : 0
    }
    return { ...base, ...timing(), fingerprint: input, state: 'examined', telemetry, evidence: {
      initiative: chosenInitiative?.initiative ?? null, destination,
      initiativeRanks: ranks(initiativeAnswer), destinationRanks: destinationAnswer ? ranks(destinationAnswer) : [],
      initiativeConfidence: initiativeAnswer.confidence, destinationConfidence: destinationAnswer?.confidence ?? 0,
      initiativeFit: probability('initiative_fit'), epicFit: probability('epic_fit'), ambiguous: probability('ambiguous'),
      initiativeOnly: questions.initiative_only ? probability('initiative_only') : null,
      parentConflict, sourceComplete: !!title && !!(brief || description || area || parentFacts.length) && hierarchy.complete && body.outcome === 'available',
      parentCount: hierarchy.parents.length, bodyAvailable: body.outcome === 'available',
    } }
  } catch (error) {
    return { ...base, ...timing(), fingerprint: input, state: 'failed',
      reason: error instanceof JevError ? error.code : 'classification-failed',
      httpStatus: error instanceof JevError ? error.status : undefined }
  }
}

export type Threshold = { choice: number; margin: number; fit: number; ambiguity: number }
export const thresholds = {
  exploratory: { choice: 0.70, margin: 0.20, fit: 0.70, ambiguity: 0.30 },
  conservative: { choice: 0.85, margin: 0.40, fit: 0.85, ambiguity: 0.20 },
  strict: { choice: 0.95, margin: 0.60, fit: 0.95, ambiguity: 0.10 },
} satisfies Record<string, Threshold>

export function assess(result: Classification, threshold: Threshold) {
  if (result.state !== 'examined') return { outcome: result.state, reason: result.reason } as const
  const evidence = result.evidence
  const review = (reason: string) => ({ outcome: 'needs-review', reason } as const)
  if (!evidence.sourceComplete) return review('incomplete-source')
  if (evidence.parentConflict) return review('parent-conflict')
  if (!evidence.initiative || evidence.initiativeFit < threshold.fit) return review('initiative-no-fit')
  if (!evidence.destination) return review('epic-no-fit')
  if (evidence.initiative !== evidence.destination.initiative) return review('choice-conflict')
  if (evidence.destination.epic === null) {
    if ((evidence.initiativeOnly ?? 0) < threshold.fit || evidence.epicFit > 1 - threshold.fit) return review('initiative-only-unconfirmed')
  } else if (evidence.epicFit < threshold.fit) return review('epic-no-fit')
  if (evidence.ambiguous > threshold.ambiguity) return review('ambiguous')
  for (const ranking of [evidence.initiativeRanks, evidence.destinationRanks]) {
    const first = ranking[0]?.probability ?? 0, second = ranking[1]?.probability ?? 0
    if (first < threshold.choice || first - second < threshold.margin) return review('low-choice-margin')
  }
  return { outcome: 'candidate', destination: evidence.destination } as const
}
