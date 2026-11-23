import { checkInTime } from './checkIn'
import { isJiraPilotCard } from './workIdentity'

/** One Waiting For policy for writes and read-side diagnostics.
 * Waiting For is an independent blocker. Queue position and a missing worker stay Queued. */
export const waitingForTypes = ['Actor', 'Event', 'Work'] as const
export type WaitingForType = typeof waitingForTypes[number]
export type SourceCoverage = 'complete' | 'partial' | 'unknown'

export interface WaitIssue { code: string; field: string; message: string }
export interface WaitingForException {
  card_id: string
  field: string
  reason: string
  observed_at: string | null
  coverage: SourceCoverage
}
export interface WaitingForIssue extends WaitingForException {
  code: string
  category: 'classification' | 'description' | 'reference' | 'status'
}
interface WaitIdentity { type: string; id: string }
interface WaitDescription { dependency: string; unblocks_when: string; follow_up_by: string }
type WaitFields = WaitIdentity & WaitDescription
export interface WaitState extends WaitIdentity {
  cardId: string
  status: string
  waitingFor: string
  nextCheckIn?: { start?: string; time_zone?: string } | null
  observedAt: string | null
}
export interface WorkBlocker {
  id: string
  status: string
  title?: string
  archived?: boolean
  in_trash?: boolean
}
interface CardFields {
  id: string
  last_edited_time?: string
  archived?: boolean
  in_trash?: boolean
  properties: Record<string, { value: unknown }>
}

export function waitState(card: CardFields): WaitState {
  const text = (name: string) => String(card.properties[name]?.value ?? '')
  return { cardId: card.id, status: text('Status'), type: text('Waiting For Type'), id: text('Waiting For ID'),
    waitingFor: text('Waiting For'), nextCheckIn: card.properties['Next check-in']?.value as WaitState['nextCheckIn'],
    observedAt: card.last_edited_time ?? null }
}

export function workBlocker(card: CardFields): WorkBlocker {
  return { id: card.id, status: String(card.properties.Status?.value ?? ''), title: String(card.properties.Name?.value ?? ''),
    archived: card.archived, in_trash: card.in_trash }
}

export const closedWorkBlocker = (card: WorkBlocker) => card.archived || card.in_trash || ['Done', 'Archived'].includes(card.status)

const NOTION_ID = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i
const SCHEDULE_WORD = /\b(next|check-?in|check|in|on|at|date|the|a|an|waiting|wait|for|until|by|scheduled|arbitrary|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|et|eastern)\b/gi

export const DISPATCH_WAIT_REASON = 'Waiting For must name an independent blocker: a person, team, vendor, an event that happens on its own, or another unfinished card. Waiting for a worker to be assigned, started, or attached, for First Mate to pick up, for a place in the queue, or for a check-in date alone does not qualify.'

export function canonicalWorkId(id: string): string | null {
  if (isJiraPilotCard(id)) return id
  return NOTION_ID.test(id) ? id.replaceAll('-', '').toLowerCase() : null
}

export function coverageFromObservation(status?: string, coverage?: string): SourceCoverage {
  if (status === 'fresh' && coverage === 'complete') return 'complete'
  if ((status === 'fresh' || status === 'partial') && coverage === 'partial') return 'partial'
  return 'unknown'
}

const entryText = (text: string) => /[\r\n]/.test(text) || text.startsWith('"') || text.includes(' | ')
  ? JSON.stringify(text).replaceAll('|', '\\u007c') : text

/** The exact Waiting For line a later resolve must match. */
export function waitLine(value: { dependency: string; unblocks_when: string; follow_up_by?: string; type: string; id: string }): string {
  const followUp = value.follow_up_by === undefined ? '' : ` | Follow-up: ${entryText(value.follow_up_by)}`
  return `${value.type === 'Actor' && value.id === 'Will' ? 'Will: ' : ''}Dependency: ${entryText(value.dependency)} | Unblocks when: ${entryText(value.unblocks_when)}${followUp} | Type: ${value.type} | ID: ${entryText(value.id)}`
}

const decode = (text: string) => {
  if (!text.startsWith('"')) return text
  try { const value: unknown = JSON.parse(text); return typeof value === 'string' ? value : text } catch { return text }
}

function inlineWait(line: string): (Omit<WaitFields, 'follow_up_by'> & { follow_up_by?: string }) | null {
  const match = /^(?:Will: )?Dependency: (.*) \| Unblocks when: (.*?)(?: \| Follow-up: (.*))? \| Type: (.*) \| ID: (.*)$/.exec(line)
  if (!match) return null
  return { dependency: decode(match[1]!), unblocks_when: decode(match[2]!), follow_up_by: match[3] === undefined ? undefined : decode(match[3]), type: match[4]!, id: decode(match[5]!) }
}

function typedWait(fields: Partial<WaitFields>, authored = false): (WaitFields & { type: WaitingForType }) | null {
  const { type, id, dependency, unblocks_when, follow_up_by = '' } = fields
  const canonical = type?.trim() ?? ''
  if (!canonicalType(canonical) || !id?.trim() || !dependency?.trim() || !unblocks_when?.trim() || (!authored && !follow_up_by.trim())) return null
  return { type: canonical, id, dependency, unblocks_when, follow_up_by }
}

export function parseWaitLine(line: string) {
  const fields = inlineWait(line)
  return fields && typedWait(fields, fields.follow_up_by === undefined)
}

const descriptionFields = {
  dependency: 'Dependency',
  unblocks_when: 'Unblocks when',
  follow_up_by: 'Follow-up by',
} as const
const labels: Record<string, keyof WaitDescription> = {
  dependency: 'dependency', 'unblocks when': 'unblocks_when', 'follow-up by': 'follow_up_by',
}
const authoredLabel = /^(?:Will: )?(Dependency|Unblocks when|Follow-up by):[ \t]*(.*)$/i
interface WaitEntry { text: string; fields: Partial<WaitFields>; authored?: boolean; implicitIdentity?: boolean; freeForm?: boolean }

/** Read the authored text and the generated entries without changing what an exact resolution matches. */
export function waitEntries(text: string, primary: WaitIdentity): WaitEntry[] {
  const entries: WaitEntry[] = []
  let prose: string[] = []
  let trailing: string[] = []
  let leadingProse = 0
  let block: WaitEntry | undefined
  let implicitIdentityUsed = false
  const addFreeForm = (lines: string[]) => {
    for (const text of lines) if (text.trim()) entries.push({ text, fields: { dependency: text }, freeForm: true })
  }
  const addAuthored = (entry: WaitEntry) => {
    if (!implicitIdentityUsed) {
      Object.assign(entry.fields, { type: primary.type, id: primary.id })
      entry.implicitIdentity = true
      implicitIdentityUsed = true
    }
    entries.push(entry)
  }
  const finish = () => {
    if (!block) return
    const prefix = prose.slice(0, leadingProse)
    if (block.fields.dependency?.trim()) {
      addFreeForm(prefix)
      let fragment: WaitEntry | undefined
      for (const line of block.text.split('\n')) {
        const labeled = authoredLabel.exec(line.trim())
        if (labeled) {
          if (fragment) fragment.text += '\n' + line
          else fragment = { text: line, fields: {}, authored: true }
          fragment.fields[labels[labeled[1]!.toLowerCase()]!] = labeled[2]!
        } else if (line.trim()) {
          if (fragment) {
            fragment.text = fragment.text.replace(/(?:\n[^\S\n]*)+$/, '')
            addAuthored(fragment)
            fragment = undefined
          }
          addFreeForm([line])
        } else if (fragment) fragment.text += '\n' + line
      }
      if (fragment) addAuthored(fragment)
    } else {
      const dependency = prose.join('\n').trim()
      if (dependency) block.fields.dependency = dependency
      if (prefix.length) block.text = [...prefix, block.text].join('\n')
      addAuthored(block)
    }
    block = undefined
    prose = trailing
    trailing = []
  }
  for (const line of text.split('\n')) {
    const inline = inlineWait(line.replace(/\r$/, ''))
    const labeled = authoredLabel.exec(line.trim())
    if (inline) {
      finish()
      addFreeForm(prose)
      prose = []
      entries.push({ text: line, fields: inline, authored: inline.follow_up_by === undefined })
      continue
    }
    if (!labeled) {
      if (block) trailing.push(line)
      else if (line.trim() || prose.length) prose.push(line)
      continue
    }
    const field = labels[labeled[1]!.toLowerCase()]!
    if (!block || field in block.fields) {
      finish()
      leadingProse = prose.length
      block = { text: line, fields: {}, authored: true }
    } else {
      prose.push(...trailing)
      block.text = [block.text, ...trailing, line].join('\n')
      trailing = []
    }
    block.fields[field] = labeled[2]!
  }
  finish()
  addFreeForm(prose)
  return entries
}

export function retainedWaitText({ text, fields, implicitIdentity, authored }: WaitEntry, primary: WaitIdentity): string {
  const { type = '', id = '', dependency = '', unblocks_when = '', follow_up_by = '' } = fields
  if (!implicitIdentity || (!type && !id) || (type === primary.type && id === primary.id)) return text
  return waitLine({ type, id, dependency, unblocks_when, follow_up_by: authored && !follow_up_by.trim() ? undefined : follow_up_by })
}

export const typedWaitEntry = (entry: WaitEntry) => typedWait(entry.fields, entry.authored)

function scheduleOnly(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (!/\b(?:check-?\s*in|checkpoint)\b/i.test(trimmed) && !/^\d{4}-\d{2}-\d{2}(?:[t ]|\b)/i.test(trimmed)) return false
  const residue = trimmed.replace(SCHEDULE_WORD, ' ').replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:?\d{2})?)?/gi, ' ').replace(/\b\d{1,2}(?::\d{2})?\b/g, ' ').replace(/[^a-z]+/gi, ' ').trim()
  return residue.length === 0
}

/** True when the text gives no independent prerequisite. Follow-up owner is not part of this check. */
export function dispatchOnlyWait(dependency: string, unblocksWhen: string): boolean {
  const outcome = unblocksWhen.trim()
  const text = !outcome || /^(?:when )?(?:that|this|it) happens[.!]?$/i.test(outcome) ? dependency.trim() : outcome
  return scheduleOnly(text) || [
    /^(?:(?:waiting|wait) for |pending |when |once |after )?(?:a |the |this |our )?worker(?: to be| is| gets| has been| to)? (?:assign(?:ed|ment)|start(?:ed|s|ing)?|attach(?:ed|es|ing)?)(?:\b|$)/i,
    /^(?:(?:waiting|wait) for |pending |when |once |after )?.+? (?:to |is |will |can )?(?:start(?:s|ing)?(?:\/attach)?|attach(?:es|ing)?|assign(?:s|ing)?) (?:a |the |this |our )?worker\b/i,
    /^(?:(?:waiting|wait) for |pending |when |once |after )?(?:first\s*mate|hilda(?: mate)?) (?:to |is |will |can )?pick(?:s|ing)?\s*(?:(?:it|this card)\s+)?up\b/i,
    /^(?:queued behind|behind other) (?:other )?(?:tasks|work|cards|items)\b/i,
  ].some(phrase => phrase.test(text))
}

export function independentWaitIssue(wait: { type: string; id: string; dependency: string; unblocks_when: string }): WaitIssue | null {
  if (!wait.dependency.trim() || !wait.unblocks_when.trim()) {
    return { code: 'placeholder-blocker', field: 'dependency', message: `${DISPATCH_WAIT_REASON} Supply a dependency and its unblock outcome.` }
  }
  if (dispatchOnlyWait(wait.dependency, wait.unblocks_when)) return { code: 'not-independent', field: 'unblocks_when', message: DISPATCH_WAIT_REASON }
  return null
}

const canonicalType = (type: string): type is WaitingForType => waitingForTypes.some(value => value === type)
const comparableWaitId = (type: string, id: string) => type === 'Work' ? canonicalWorkId(id.trim()) : id.trim()

export function workIdShape(cardId: string, workId: string): WaitIssue | null {
  const canonical = canonicalWorkId(workId)
  if (!canonical) return { code: 'invalid-work-id', field: 'id', message: 'Work needs a card ID. Use the exact Notion or synthetic Jira pilot card ID, or use Type=Event for a non-card reference.' }
  if (canonical === canonicalWorkId(cardId)) return { code: 'work-self', field: 'id', message: 'Choose the exact ID of the other card that blocks this work.' }
  return null
}

function identityIssues(cardId: string, identity: WaitIdentity, add: AddIssue) {
  const type = identity.type.trim(), id = identity.id.trim()
  if (!type) add('classification', 'missing-type', 'Waiting For Type', 'Waiting For Type is missing. Choose Actor, Event or Work.')
  else if (type === 'Person') add('classification', 'legacy-type', 'Waiting For Type', 'Replace legacy Person with Actor and retain the named blocker as the Actor ID.')
  else if (type === 'Card') add('classification', 'legacy-type', 'Waiting For Type', 'Replace legacy Card with Work and confirm the exact ID of the blocking card.')
  else if (!canonicalType(type)) add('classification', 'invalid-type', 'Waiting For Type', `“${type}” is unsupported. Choose Actor, Event or Work for the recorded blocker.`)
  if (!id) add('classification', 'missing-id', 'Waiting For ID', 'Waiting For ID is missing. Enter the actor identity, event description or reference, or exact Work card ID.')
  else if (type === 'Work') {
    const shape = workIdShape(cardId, id)
    if (shape) add('classification', shape.code, 'Waiting For ID', shape.message)
  }
}

export function waitingForWorkIds(input: WaitState): string[] {
  if (input.status !== 'Waiting For') return []
  const identities = [input, ...waitEntries(input.waitingFor, input).map(entry => entry.fields)]
  return [...new Set(identities.flatMap(({ type, id }) => {
    const canonical = type?.trim() === 'Work' && id ? canonicalWorkId(id.trim()) : null
    return canonical && canonical !== canonicalWorkId(input.cardId) ? [canonical] : []
  }))]
}

export function hasActiveTypedWait(input: { type: string; id: string; waitingFor: string }): boolean {
  return !!input.type.trim() || !!input.id.trim() || waitEntries(input.waitingFor, input).some(entry => typedWaitEntry(entry) !== null)
}

type AddIssue = (category: WaitingForIssue['category'], code: string, field: string, reason: string) => void
type WaitObservation = WaitState & { coverage: SourceCoverage }

export function waitingForIssues(input: WaitObservation, work: ReadonlyMap<string, WorkBlocker> = new Map()): WaitingForIssue[] {
  const { cardId, status, coverage, observedAt, waitingFor } = input
  const issues: WaitingForIssue[] = []
  const add: AddIssue = (category, code, field, reason) => {
    if (issues.some(issue => issue.code === code && issue.field === field && issue.reason === reason)) return
    issues.push({ card_id: cardId, category, code, field, reason, coverage, observed_at: observedAt })
  }
  if (status === 'Waiting For') {
    identityIssues(cardId, input, add)
    const entries = waitEntries(waitingFor, input)
    const descriptions: Pick<WaitEntry, 'fields' | 'authored'>[] = entries.length ? entries : [{ fields: {} }]
    let hasPrimary = false
    for (const { fields, authored } of descriptions) {
      const { type, id, dependency, unblocks_when } = fields
      if (type !== undefined || id !== undefined) {
        identityIssues(cardId, { type: type ?? '', id: id ?? '' }, add)
        hasPrimary ||= !!type && type.trim() === input.type.trim() && comparableWaitId(type.trim(), id ?? '') === comparableWaitId(type.trim(), input.id)
      }
      for (const key of Object.keys(descriptionFields) as (keyof WaitDescription)[]) {
        if (key === 'follow_up_by' && authored) continue
        const label = descriptionFields[key]
        if (!fields[key]?.trim()) add('description', `missing-${key}`, label, `Add ${label} to the active Waiting For description.`)
      }
      if (dependency && unblocks_when && dispatchOnlyWait(dependency, unblocks_when)) {
        add('description', 'not-independent', 'Unblocks when', DISPATCH_WAIT_REASON)
      }
    }
    if (entries.length && entries.every(({ fields }) => fields.type && fields.id) && !hasPrimary) {
      add('classification', 'primary-mismatch', 'Waiting For Type / ID', 'Match Waiting For Type and ID to one of the active wait entries.')
    }
    for (const id of waitingForWorkIds(input)) {
      const target = work.get(id)
      if (!target) add('reference', 'work-unverified', 'Waiting For ID', `Work card ${id} needs verification. Its status is unknown. Refresh the source or check access to the exact card.`)
      else if (closedWorkBlocker(target)) add('reference', 'work-not-blocking', 'Waiting For ID', `Work card ${id} is completed, archived or deleted. Review the dependency and resolve it explicitly if it has cleared.`)
    }
    if (!Number.isFinite(checkInTime(input.nextCheckIn?.start ?? null, input.nextCheckIn?.time_zone))) {
      add('description', 'missing-check-in', 'Next check-in', 'Set a valid Next check-in for this wait.')
    }
  } else if (['Queued', 'Todo', 'Backlog', 'In Progress'].includes(status)) {
    if (hasActiveTypedWait(input)) add('status', 'wait-unresolved', 'Waiting For', `Status is ${status}, but an unresolved typed blocker remains. Resolve the exact active wait or restore Waiting For; no fields were rewritten.`)
    else if (waitEntries(waitingFor, input).some(({ fields }) => dispatchOnlyWait(fields.dependency ?? '', fields.unblocks_when ?? ''))) {
      add('description', 'not-independent', 'Waiting For', `${DISPATCH_WAIT_REASON} Status is ${status}; this text was not rewritten.`)
    }
  }
  // Keep the compatibility summary pointed at classification and reference issues first.
  return [...issues.filter(issue => issue.category !== 'description'), ...issues.filter(issue => issue.category === 'description')]
}
