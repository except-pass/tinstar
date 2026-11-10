import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ReleaseTransitionProposal } from '../../shared/releaseAutomation'
import type { ReleasesRead } from '../../shared/releases'
import type { QueueItem } from '../reconciliation/queue'
import type { WorkCard, WorkReader } from '../reconciliation/workReader'
import { WorkflowContent, richText } from '../reconciliation/workflowContent'
import { readAutomationSettings } from './automation'

export interface ReleaseTransport {
  card(id: string): Promise<WorkCard>
  hasNote(id: string, marker: string): Promise<boolean>
  note(id: string, text: string, marker: string): Promise<void>
  transition(card: WorkCard, proposal: ReleaseTransitionProposal): Promise<void>
}
/** Reuse the paced Notion reader/content transport and its comment readback.
 * Status-only PATCH preserves existing asks, owners and unrelated properties. */
export function notionReleaseTransport(reader: WorkReader): ReleaseTransport {
  const content = new WorkflowContent(reader)
  return {
    card: id => reader.card(id, true),
    hasNote: async (id, marker) => (await content.notes(id)).some(note => note.text.split('\n').includes(marker)),
    note: (id, text, marker) => content.note(id, text, marker),
    transition: async (card, proposal) => {
      const type = card.properties.Status?.type
      if (type !== 'status' && type !== 'select') throw new Error('Unsupported Status property')
      const properties: Record<string, unknown> = { Status: { [type]: { name: proposal.to } } }
      // Preserve any existing actionable instruction. The shared Desk publisher
      // carries this production check even when Next action is already occupied.
      if (proposal.desk && card.properties['Next action']?.type === 'rich_text' && !card.properties['Next action'].value) properties['Next action'] = richText(proposal.desk.item.action!)
      await content.request(`pages/${card.id}`, 'PATCH', { properties })
      const current = await reader.card(card.id, true)
      if (current.properties.Status?.value !== proposal.to) throw new Error('Release status readback differs; retry to inspect current state')
      reader.confirm(current)
    },
  }
}

export interface ReleaseWriteRecord {
  proposal: ReleaseTransitionProposal
  phase: 'pending' | 'done' | 'skipped'
  createdAt: string
  updatedAt: string
  lastError?: string
  disposition?: { actor: string; reason: string }
  history?: Array<{ action: 'skip' | 'resume'; actor: string; reason: string; at: string }>
}
interface Journal { version: 1; records: ReleaseWriteRecord[]; recovery?: { actor: string; reason: string; backup: string; at: string } }
const marker = (proposal: ReleaseTransitionProposal) => `Tin Star release: ${proposal.id}`
const property = (card: WorkCard, name: string) => card.properties[name]?.value
const sameOwner = (card: WorkCard, proposal: ReleaseTransitionProposal) => String(property(card, 'Owner') ?? '').trim() === proposal.owner
const eligibleCard = (card: WorkCard, proposal: ReleaseTransitionProposal) => !card.archived && !card.in_trash &&
  property(card, 'Status') === proposal.from && sameOwner(card, proposal) &&
  card.properties['Requires production verification']?.type === 'checkbox' &&
  typeof property(card, 'Requires production verification') === 'boolean' &&
  property(card, 'Requires production verification') === (proposal.kind === 'verify-in-production')

/** One runner per existing single-server config root. The durable journal is an
 * execution receipt store, not a second Desk or release service. No GET runs it.
 * A missing/invalid journal blocks writes to avoid losing retry identity. */
export class ReleaseAutomationWriter {
  private running: Promise<unknown> | null = null
  private file: string
  constructor(private root: string, private transport: ReleaseTransport, private read: () => Promise<ReleasesRead>, private now = () => new Date().toISOString()) {
    this.file = join(root, 'releases', 'writer-receipts.json')
  }
  private async journal(): Promise<Journal> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as Journal
      if (value.version !== 1 || !Array.isArray(value.records) || value.records.some(row => !row.proposal?.id || !row.proposal.cardId || !['pending', 'done', 'skipped'].includes(row.phase)) || new Set(value.records.map(row => row.proposal.id)).size !== value.records.length) throw new Error('Invalid release writer journal')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] }; throw error }
  }
  private async save(journal: Journal) {
    await mkdir(join(this.root, 'releases'), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify(journal, null, 2), { mode: 0o600 })
    await rename(temporary, this.file)
  }
  async receipts() { return (await this.journal()).records }
  async recoverReceipts(actor: string, reason: string) {
    if (!actor.trim() || !reason.trim()) throw new Error('Actor and reason required')
    if (this.running || await this.enabled()) throw new Error('Disable automation and wait for the active pass before recovering receipts')
    const backup = `${this.file}.recovery-${randomUUID()}`
    await rename(this.file, backup)
    const recovery = { actor, reason, backup, at: this.now() }
    await this.save({ version: 1, records: [], recovery })
    return recovery
  }
  run(): Promise<unknown> {
    if (this.running) return this.running
    this.running = this.perform().finally(() => { this.running = null })
    return this.running
  }
  private async enabled() { return (await readAutomationSettings(this.root)).requestedEnabled }
  private async perform() {
    // OFF makes no board, source, or journal reads/writes. Switch is operator-only.
    if (!await this.enabled()) return { enabled: false, completed: [] }
    const journal = await this.journal(), data = await this.read()
    if (data.reconciliation?.sourceStatus !== 'fresh') return { enabled: true, held: 'Current production evidence is required; historical snapshots never authorize writes', completed: [] }
    const proposals = data.automation?.proposals ?? [], completed: string[] = []
    for (const proposal of proposals) {
      if (!journal.records.some(row => row.proposal.id === proposal.id)) journal.records.push({ proposal, phase: 'pending', createdAt: this.now(), updatedAt: this.now() })
    }
    // Persist intent before side effects. Pending operations survive restart,
    // including a lost PATCH/comment response. Completed operations never replay.
    await this.save(journal)
    for (const row of journal.records.filter(row => row.phase === 'pending')) {
      const proposal = row.proposal, receipt = marker(proposal)
      try {
        if (!await this.enabled()) break
        let card = await this.transport.card(proposal.cardId)
        if (property(card, 'Status') === proposal.to && await this.transport.hasNote(card.id, receipt)) {
          // Recovery confirms only our receipt; never reapply a status or comment.
          row.phase = 'done'; row.updatedAt = this.now(); delete row.lastError; await this.save(journal); completed.push(proposal.id); continue
        }
        const fresh = await this.read()
        const current = fresh.automation?.proposals.find(candidate => candidate.id === proposal.id)
        if (fresh.reconciliation?.sourceStatus !== 'fresh' || !current || !eligibleCard(card, current)) throw new Error('Current status, checkbox, owner, associations or production evidence changed; held for reconciliation')
        await this.transport.note(card.id, proposal.auditText, receipt)
        // Revalidate after the comment, immediately before the status write. A
        // changed opt-in flag or another required PR must never inherit old proof.
        card = await this.transport.card(card.id)
        const beforeWrite = await this.read()
        if (!await this.enabled() || beforeWrite.reconciliation?.sourceStatus !== 'fresh' || !beforeWrite.automation?.proposals.some(candidate => candidate.id === proposal.id) || !eligibleCard(card, proposal)) throw new Error('Preconditions changed before status write; held for reconciliation')
        await this.transport.transition(card, proposal)
        row.phase = 'done'; row.updatedAt = this.now(); delete row.lastError; completed.push(proposal.id)
      } catch {
        row.lastError = 'Write unconfirmed or current preconditions changed. Next pass re-reads the card and marker before retrying; inspect card and receipts.'
        row.updatedAt = this.now()
      }
      await this.save(journal)
    }
    return { enabled: true, completed }
  }
  /** Operator escape for a stuck operation: audited skip/resume, never an
   * override of shipment evidence or direct edit of the journal. A manual card
   * disposition remains available through the existing audited work workflow. */
  async disposition(id: string, action: 'skip' | 'resume', actor: string, reason: string) {
    if (!actor.trim() || !reason.trim()) throw new Error('Actor and reason required')
    if (this.running) throw new Error('Writer pass is active; retry after it completes')
    const journal = await this.journal(), row = journal.records.find(row => row.proposal.id === id)
    if (!row) throw new Error('Release operation not found')
    if (row.phase === 'done') throw new Error('Completed operations cannot be replayed; use the existing card workflow for correction')
    row.phase = action === 'skip' ? 'skipped' : 'pending'; row.disposition = { actor, reason }; row.updatedAt = this.now()
    row.history = [...(row.history ?? []), { action, actor, reason, at: row.updatedAt }]
    await this.save(journal)
    return row
  }
  /** Publish through the shared Desk queue, using current card/owner/status.
   * Only a confirmed opt-in route appears; reads never acknowledge verification. */
  async desk(cards: WorkCard[]): Promise<QueueItem[]> {
    const result: QueueItem[] = []
    for (const row of (await this.journal()).records) {
      const { proposal } = row, card = cards.find(card => card.id === proposal.cardId)
      if (row.phase !== 'done' || !proposal.desk || !card || card.archived || card.in_trash || property(card, 'Status') !== 'In Progress' || property(card, 'Requires production verification') !== true) continue
      const owner = String(property(card, 'Owner') ?? '').trim()
      if (!owner) continue
      const item = proposal.desk.item
      result.push({ ...item, title: `${owner}: ${item.title}`, readiness: 'ready-now', reasons: [],
        sources: item.sources.map(source => ({ ...source, request: { home: null, taskId: null, id: card.id, kind: 'notion-card' }, actions: ['Production verification'], action: item.action,
          readiness: 'ready-now', reasons: [], status: 'fresh', coverage: 'complete', observedAt: this.now(), expiresAt: new Date(Date.parse(this.now()) + 120_000).toISOString() })) })
    }
    return result
  }
}
