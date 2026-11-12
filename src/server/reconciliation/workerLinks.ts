import { record } from './values'

export const FIRST_MATE_TASKS = 'First Mate tasks'
export const WORKER_LINK_SCHEMA = 'tinstar.fm-links.v1'
// Notion accepts at most 100 rich-text items of 2,000 characters each.
// Bound parsing too, so malformed remote input cannot consume unbounded work.
export const MAX_WORKER_LINK_CHARS = 200_000
export interface WorkerLink { fm_home: string; task_id: string; first_observed_spawn_gen: string }
export type WorkerLinks = { status: 'valid'; tasks: WorkerLink[] } |
  { status: 'unknown' | 'invalid'; reason: string }

// A blank property is unknown, like a missing one, but it is the normal unset
// state. Callers suppress absence from the status and skip a per-card finding.
export const BLANK_PROPERTY_REASON = 'Blank property is unlinked'
export const isBlankWorkerLinks = (value: WorkerLinks): boolean =>
  value.status === 'unknown' && value.reason === BLANK_PROPERTY_REASON

const invalid = (reason: string): WorkerLinks => ({ status: 'invalid', reason })
const identityString = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
const canonicalHome = (value: unknown): value is string => identityString(value) && value.startsWith('/') &&
  (value === '/' || !value.endsWith('/')) && !value.includes('//') &&
  !value.split('/').some(part => part === '.' || part === '..')
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

// JSON.parse otherwise silently keeps the last repeated key, which can hide
// competing home/identity declarations in an apparently valid record.
function duplicateJsonKeys(value: string): boolean {
  const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? []
  const stack: Array<Set<string> | null> = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '{') stack.push(new Set())
    else if (token === '[') stack.push(null)
    else if (token === '}' || token === ']') stack.pop()
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1)
      const key = JSON.parse(token) as string
      if (keys?.has(key)) return true
      keys?.add(key)
    }
  }
  return false
}

/** Identity strings are compared verbatim, never resolved as paths or executed. */
export function parseWorkerLinks(value: unknown): WorkerLinks {
  if (typeof value !== 'string') return { status: 'unknown', reason: 'Property is missing or unreadable' }
  if (value.length > MAX_WORKER_LINK_CHARS) return invalid('Record exceeds 200,000 characters')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return invalid('Malformed JSON') }
  if (duplicateJsonKeys(value)) return invalid('Duplicate JSON object key')
  const root = record(parsed)
  if (root.schema !== WORKER_LINK_SCHEMA) return invalid('Unknown schema')
  if (!exactKeys(root, ['schema', 'tasks']) || !Array.isArray(root.tasks)) return invalid('Expected only schema and tasks array')
  const tasks: WorkerLink[] = []
  const seen = new Set<string>()
  for (const entry of root.tasks) {
    const task = record(entry)
    if (!exactKeys(task, ['fm_home', 'task_id', 'first_observed_spawn_gen'])) return invalid('Expected only worker identity and spawn provenance fields')
    if (!canonicalHome(task.fm_home)) return invalid('Missing or ambiguous fm_home; expected canonical absolute home')
    if (!identityString(task.task_id)) return invalid('Missing or ambiguous task_id')
    if (!identityString(task.first_observed_spawn_gen)) return invalid('Missing or ambiguous first_observed_spawn_gen')
    const id = JSON.stringify([task.fm_home, task.task_id])
    if (seen.has(id)) return invalid('Duplicate worker entry')
    seen.add(id)
    tasks.push({ fm_home: task.fm_home, task_id: task.task_id, first_observed_spawn_gen: task.first_observed_spawn_gen })
  }
  return { status: 'valid', tasks }
}

/** Identities that can be compared when a declaration is not valid.
 * Null means the text cannot prove which tasks it names: it does not parse,
 * hides a key, has no tasks array, or has an entry without an unambiguous
 * fm_home and task_id. A list is not a valid declaration and must not bind a
 * card. Decision binding uses it so a readable other-task record is a non-match
 * instead of unknown coverage that blocks every decision on the board.
 */
export function readableTaskIdentities(text: unknown): Array<{ fm_home: string; task_id: string }> | null {
  if (typeof text !== 'string' || text.length > MAX_WORKER_LINK_CHARS) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (duplicateJsonKeys(text)) return null
  const tasks = record(parsed).tasks
  if (!Array.isArray(tasks)) return null
  const identities: Array<{ fm_home: string; task_id: string }> = []
  for (const entry of tasks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const task = record(entry)
    if (!identityString(task.fm_home) || !identityString(task.task_id)) return null
    identities.push({ fm_home: task.fm_home, task_id: task.task_id })
  }
  return identities
}

/** Validate the wire property before concatenation; never silently drop an item. */
export function readWorkerLinks(value: unknown): WorkerLinks {
  const p = record(value)
  if (p.type !== 'rich_text' || !Array.isArray(p.rich_text) || p.has_more === true) {
    return { status: 'unknown', reason: 'First Mate tasks is missing, unreadable or truncated' }
  }
  if (p.rich_text.length > 100) return invalid('Property exceeds 100 rich-text items')
  const chunks: string[] = []
  for (const item of p.rich_text) {
    const rich = record(item)
    const chunk = rich.plain_text ?? record(rich.text).content
    if (typeof chunk !== 'string') return { status: 'unknown', reason: 'Unreadable rich-text item' }
    if (chunk.length > 2000) return invalid('Rich-text item exceeds 2,000 characters')
    chunks.push(chunk)
  }
  // Empty or whitespace-only text is not a JSON record and not an explicit
  // empty declaration. Any other text is still parsed and can still be invalid.
  const text = chunks.join('')
  if (text.trim() === '') return { status: 'unknown', reason: BLANK_PROPERTY_REASON }
  return parseWorkerLinks(text)
}

/** Coordinator-only recovery; the ordinary reader remains atomic and invalid.
 * Keep exact valid identities from damaged records, without interpreting prose.
 */
export function recoverWorkerLinks(links: WorkerLinks, text: unknown): WorkerLink[] | undefined {
  if (links.status !== 'invalid' || typeof text !== 'string' || text.length > MAX_WORKER_LINK_CHARS) return
  const parsedLinks = parseWorkerLinks(text)
  // Wire limit failures must not be turned into permission to overwrite.
  if (parsedLinks.status !== 'invalid' || parsedLinks.reason !== links.reason) return
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    // Broken JSON containing identity fields may conceal existing links. Retain
    // it for investigation rather than risk deleting an unrecoverable sibling.
    return /"(?:schema|tasks|fm_home|task_id|first_observed_spawn_gen)"\s*:/.test(text) ? undefined : []
  }
  // JSON.parse loses repeated keys; neither identity can safely be preferred.
  if (duplicateJsonKeys(text)) return
  const tasks: WorkerLink[] = []
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue }
    const row = record(value)
    if (['fm_home', 'task_id', 'first_observed_spawn_gen'].some(key => Object.hasOwn(row, key))) {
      if (!canonicalHome(row.fm_home) || !identityString(row.task_id) || !identityString(row.first_observed_spawn_gen)) return
      tasks.push({ fm_home: row.fm_home, task_id: row.task_id, first_observed_spawn_gen: row.first_observed_spawn_gen })
    }
    for (const child of Object.values(row)) if (child && typeof child === 'object') pending.push(child)
  }
  const unique = [...new Map(tasks.map(task => [JSON.stringify(task), task])).values()]
  // Conflicting generations cannot be collapsed to a single v1 entry.
  if (parseWorkerLinks(JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: unique })).status !== 'valid') return
  return unique
}

/** Complete wire replacement; validation and limits apply to the whole record. */
export function workerLinkRecord(tasks: WorkerLink[]) {
  const record = { schema: WORKER_LINK_SCHEMA, tasks }
  const json = JSON.stringify(record)
  if (parseWorkerLinks(json).status !== 'valid') throw new Error('Invalid or oversized worker-link record')
  const rich_text: Array<{ type: 'text'; text: { content: string } }> = []
  let chunk = ''
  for (const char of json) {
    if (chunk.length + char.length > 2000) { rich_text.push({ type: 'text', text: { content: chunk } }); chunk = '' }
    chunk += char
  }
  if (chunk) rich_text.push({ type: 'text', text: { content: chunk } })
  if (rich_text.length > 100) throw new Error('Worker-link record exceeds 100 rich-text items')
  return { record, json, properties: { [FIRST_MATE_TASKS]: { rich_text } } }
}
