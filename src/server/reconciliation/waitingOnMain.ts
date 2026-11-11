import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getConfigRoot } from '../configRoot'
import { ageObservation } from './observation'
import type { SourceSnapshot } from './index'
import type { ReconciliationConfig } from './config'
import type { NotionApi } from './notionApi'
import { mainHomeLabel, mainWaitField, waitAgeLabel, waitAlertDue, type MainWaitItem, type MainWaitRead, type ParentResolution } from '../../shared/waitingOnMain'

export const MAIN_WAIT_OWNER = '84d29212-4a5b-49f1-91bf-92b7adeff516'
export const MAIN_WAIT_CARD = '41550ce6d42281239fd4f9f20c901b80'

/** A recorded resolution closes the ask when its time is at or after the ask.
 * A missing list, or an ask with no timestamp, proves nothing and closes nothing. */
export function parentAskClosed(ask: { key: string; at: number | null }, resolutions: readonly ParentResolution[] | undefined): boolean {
  return ask.at !== null && !!resolutions?.some(row => row.key === ask.key && row.at >= ask.at!)
}

/** Main's published resolutions for this child. Stale, missing, or unknown mate data closes nothing. */
function mainResolutionKeys(snapshot: SourceSnapshot, parentHome: string, childHome: string, now: number): ParentResolution[] | undefined {
  const mainRow = snapshot.fleet.find(row => row.source.home === parentHome)
  const observation = mainRow ? ageObservation(mainRow.observation, now) : undefined
  const resolutions = observation?.data?.parent_resolutions
  const generated = Date.parse(observation?.data?.generated ?? '')
  const observed = Date.parse(resolutions?.observed_at ?? '')
  const fresh = !!observation && !observation.error && Number.isFinite(generated) && now - generated < 300_000 && generated <= now + 60_000 &&
    Number.isFinite(observed) && now - observed < 300_000 && observed <= now + 60_000
  if (!fresh || !resolutions) return undefined
  const mate = observation.data?.tasks.find(task => task.kind === 'secondmate' && task.paths.home === childHome && typeof task.id === 'string')
  const entry = typeof mate?.id === 'string' ? resolutions.mates[mate.id] : undefined
  return entry?.status === 'known' ? entry.keys : undefined
}

/** Positive records survive incomplete reads. Only a complete fresh source can
 * establish absence. Main identity comes from configured labels/parent links. */
export function mainWaitCandidates(snapshot: SourceSnapshot, now = Date.now()) {
  const items: MainWaitItem[] = [], unknown: string[] = [], complete = new Set<string>()
  const resolutionsBySource = new Map<string, ParentResolution[]>()
  const board = ageObservation(snapshot.intentions, now)
  const boardFresh = ['fresh', 'partial'].includes(board.status) && !!board.data
  if (board.status === 'fresh' && board.coverage === 'complete' && board.data && !board.data.hasMore) complete.add('board')
  else unknown.push('Board waits unknown or incomplete')
  for (const card of board.data?.cards ?? []) {
    const value = (name: string) => String(card.properties[name]?.value ?? '')
    if (card.archived || card.in_trash || ['done', 'archived'].includes(value('Status').toLowerCase())) continue
    const wait = value('Waiting For'), id = value('Waiting For ID')
    if (!mainWaitField(wait, id)) continue
    const truncated = ['Waiting For', 'Waiting For ID'].some(name => card.properties[name]?.hasMore)
    if (truncated) { complete.delete('board'); unknown.push('Some card wait fields are truncated') }
    items.push({ id: `card:${card.id}`, source: 'board', kind: 'card', label: value('Name') || card.id, key: card.id,
      text: [wait, id].filter(Boolean).join(' · '), since: card.last_edited_time, ageBasis: 'at least',
      url: `https://www.notion.so/${card.id}`, fresh: boardFresh && !truncated })
  }
  const main = new Set(snapshot.fleet.filter(row => mainHomeLabel(row.source.label)).map(row => row.source.home))
  if (!main.size) unknown.push('Main home identity unknown; configure its fleet label as main')
  for (const row of snapshot.fleet) {
    if (main.has(row.source.home)) continue
    const label = row.source.label ?? basename(row.source.home), source = `mate:${row.source.home}`
    if (!row.source.parentHome) { unknown.push(`${label}: parent identity unknown`); continue }
    if (!main.has(row.source.parentHome)) continue
    const observation = ageObservation(row.observation, now), asks = observation.data?.parent_asks
    const observed = Date.parse(asks?.observed_at ?? '')
    const generated = Date.parse(observation.data?.generated ?? '')
    // Ask coverage is independent of task/backlog completeness. A read error
    // or old publication still makes even an explicit empty list unknown.
    const fresh = !observation.error && Number.isFinite(generated) && now - generated < 300_000 && generated <= now + 60_000 &&
      Number.isFinite(observed) && now - observed < 300_000 && observed <= now + 60_000
    if (fresh && asks?.status === 'known') complete.add(source)
    else unknown.push(`${label}: parent asks unknown or stale`)
    const resolutions = mainResolutionKeys(snapshot, row.source.parentHome, row.source.home, now)
    if (resolutions) resolutionsBySource.set(source, resolutions)
    for (const ask of asks?.items ?? []) {
      if (parentAskClosed(ask, resolutions)) continue
      items.push({ id: JSON.stringify([source, ask.key]), source, kind: 'mate', label,
      key: ask.key, text: ask.text, since: ask.at === null ? null : new Date(ask.at * 1000).toJSON(), ageBasis: 'status timestamp', url: null,
      fresh: fresh && asks?.status === 'known' })
    }
  }
  if (!snapshot.fleet.length) unknown.push('Fleet parent asks unknown; no homes configured')
  return { items, unknown: [...new Set(unknown)], complete, resolutionsBySource }
}

export function mainWaitComment(item: MainWaitItem | MainWaitItem[], mention: boolean, now = Date.now()) {
  const excerpt = (text: string) => text.length > 200 ? `${text.slice(0, 199)}…` : text
  const describe = (row: MainWaitItem) => `${row.label} [${row.key}] · ${row.ageBasis === 'at least' ? 'at least ' : ''}${waitAgeLabel(row.since, now)} · ${excerpt(row.text)}`
  const text = Array.isArray(item) ? `Waiting on First Mate: ${item.length} existing overdue items (4h+):\n${item.map(describe).join('\n')}`
    : `Waiting on First Mate for ${item.ageBasis === 'at least' ? 'at least ' : ''}${waitAgeLabel(item.since, now)}: ${item.label} [${item.key}] · ${excerpt(item.text)}`
  const content = `${mention ? ' ' : ''}${text}`
  const chunks = Array.from({ length: Math.ceil(content.length / 2000) }, (_, index) => ({ type: 'text', text: { content: content.slice(index * 2000, (index + 1) * 2000) } }))
  return { parent: { page_id: !Array.isArray(item) && item.kind === 'card' ? item.key : MAIN_WAIT_CARD }, rich_text: [
    ...(mention ? [{ type: 'mention', mention: { type: 'user', user: { object: 'user', id: MAIN_WAIT_OWNER } } }] : []), ...chunks,
  ] }
}

/** Uses the existing paced Notion client/key; never routes a notice through main. */
export function mainWaitNotifier(config: ReconciliationConfig['notion'], api: NotionApi) {
  return async (item: MainWaitItem | MainWaitItem[], now: number): Promise<NonNullable<MainWaitItem['alert']>> => {
    if (!config) return 'failed'
    const headers = { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }
    let mention = false
    try {
      const user = await api.fetch(`https://api.notion.com/v1/users/${MAIN_WAIT_OWNER}`, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) })
      const person = user.ok ? await user.json() as { id?: string; type?: string } : null
      mention = person?.id === MAIN_WAIT_OWNER && person.type === 'person'
    } catch { /* Missing user access falls back to a visible plain comment. */ }
    const post = (withMention: boolean) => api.fetch('https://api.notion.com/v1/comments', { method: 'POST', headers, redirect: 'error',
      signal: AbortSignal.timeout(5000), body: JSON.stringify(mainWaitComment(item, withMention, now)) })
    try {
      let response = await post(mention)
      // A definite validation/permission rejection saved no comment. Other
      // failures can be ambiguous: do not repeat a possibly delivered alert.
      if (mention && [400, 403, 404].includes(response.status)) { mention = false; response = await post(false) }
      return response.ok ? mention ? 'mentioned' : 'plain-comment' : 'failed'
    } catch { return 'unconfirmed' }
  }
}

const itemSchema = z.object({ id: z.string(), source: z.string(), kind: z.enum(['card', 'mate']), label: z.string(), key: z.string(), text: z.string(),
  since: z.string().nullable(), ageBasis: z.enum(['status timestamp', 'at least']), url: z.string().nullable(), fresh: z.boolean(),
  alert: z.enum(['mentioned', 'plain-comment', 'unconfirmed', 'failed', 'disabled']).optional() })
const stateSchema = z.array(z.object({ item: itemSchema, lastAttempt: z.number().nullable() }))
const savedStateSchema = z.object({ initializedAlerts: z.boolean(), rows: stateSchema })
type SavedState = z.infer<typeof savedStateSchema>
export const mainWaitStateRoot = () => process.env.TINSTAR_STATE_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tinstar')

/** One backend owns this state, independently of config and main's health.
 * Reserve before posting: a crash/lost response cannot spam the owner on restart.
 * Failed/unconfirmed delivery is visible and becomes eligible again after 4h. */
export class WaitingOnMain {
  private pending: Promise<unknown> = Promise.resolve()
  private latest: MainWaitRead = { items: [], unknown: ['Waiting on First Mate has not refreshed'] }
  constructor(private snapshot: () => Promise<SourceSnapshot>, private notify: ReturnType<typeof mainWaitNotifier>,
    private root = mainWaitStateRoot(), private enabled: () => Promise<boolean> = async () => {
      const configRoot = getConfigRoot()
      if (/preview/i.test(basename(configRoot)) || process.env.NODE_ENV === 'test') return false
      try {
        const config = JSON.parse(await readFile(join(configRoot, 'config.json'), 'utf8'))
        return config.waitingOnMain?.deliveryEnabled !== false
      } catch { return false }
    }, private now = Date.now) {}
  view(): MainWaitRead { return structuredClone(this.latest) }
  refresh(snapshot: SourceSnapshot, deliver = false): Promise<MainWaitRead> {
    const task = this.pending.then(() => this.update(snapshot, deliver)).catch(() => {
      this.latest = { ...this.latest, items: this.latest.items.map(item => ({ ...item, fresh: false })), error: 'Waiting on First Mate state unavailable; alerts unconfirmed', unknown: ['Waiting on First Mate state/source read failed'] }
      return this.view()
    })
    this.pending = task
    return task
  }
  async sweep() {
    try { return await this.refresh(await this.snapshot(), true) }
    catch { this.latest = { ...this.latest, items: this.latest.items.map(item => ({ ...item, fresh: false })), unknown: ['Waiting on First Mate sources unavailable'] }; return this.view() }
  }
  private async save(state: SavedState) {
    await mkdir(this.root, { recursive: true })
    const path = join(this.root, 'waiting-on-main.json'), temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
    await rename(temp, path)
  }
  private async update(snapshot: SourceSnapshot, deliver: boolean) {
    let state: SavedState
    try { state = savedStateSchema.parse(JSON.parse(await readFile(join(this.root, 'waiting-on-main.json'), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = { initializedAlerts: false, rows: [] } }
    const now = this.now(), projection = mainWaitCandidates(snapshot, now)
    const saved = new Map(state.rows.map(row => [row.item.id, row]))
    const seen = new Set(projection.items.map(item => item.id))
    for (const [id, row] of saved) {
      const resolved = row.item.kind === 'mate' && parentAskClosed({ key: row.item.key,
        at: row.item.since === null ? null : Date.parse(row.item.since) / 1000 }, projection.resolutionsBySource.get(row.item.source))
      if (resolved || (!seen.has(id) && projection.complete.has(row.item.source))) saved.delete(id)
      else row.item.fresh = false
    }
    for (const item of projection.items) {
      const prior = saved.get(item.id)
      // Unrelated card edits do not restart a wait already observed. A changed
      // dependency starts a new conservative age; throttle remains per item.
      if (prior && item.kind === 'card' && prior.item.text === item.text) item.since = prior.item.since
      if (prior?.item.alert) item.alert = prior.item.alert
      saved.set(item.id, { item, lastAttempt: prior?.lastAttempt ?? null })
    }
    state.rows = [...saved.values()]
    const rows = state.rows
    await this.save(state)
    if (deliver) {
      const enabled = await this.enabled()
      if (enabled && !state.initializedAlerts && (projection.complete.size > 0 || rows.some(row => row.item.fresh))) {
        const overdue = rows.filter(row => row.item.fresh && waitAlertDue(row.item.since, row.lastAttempt, now))
        state.initializedAlerts = true
        for (const row of overdue) { row.lastAttempt = now; row.item.alert = 'unconfirmed' }
        await this.save(state)
        if (overdue.length) {
          const result = await this.notify(overdue.map(row => row.item), now)
          for (const row of overdue) row.item.alert = result
          await this.save(state)
        }
      }
      for (const row of rows) {
        if (!row.item.fresh || !waitAlertDue(row.item.since, row.lastAttempt, now)) continue
        if (!enabled) { row.item.alert = 'disabled'; continue }
        row.lastAttempt = now; row.item.alert = 'unconfirmed'
        await this.save(state)
        row.item.alert = await this.notify(row.item, now)
        await this.save(state)
      }
      await this.save(state)
    }
    this.latest = { items: rows.map(row => row.item), unknown: projection.unknown }
    return this.view()
  }
}
