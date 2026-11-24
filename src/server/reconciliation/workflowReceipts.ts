import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { acquireLock } from '../infra/lock'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ClawsonMergePlan } from '../../shared/clawsonMerge'

export interface HandoffReceiptState {
  pending?: string[]
  pending_update?: string
  contract_done?: boolean
  created?: boolean
  properties_done?: boolean
  assignment_done?: boolean
  notified?: boolean
  original?: Record<string, unknown>
}
export interface ReviewReceiptState {
  input?: unknown
  recovery_reason?: string
  original: Record<string, unknown>
  desired: Record<string, unknown>
  note: string
  actor: string
  note_pending?: boolean
  done?: boolean
}
interface JiraWorkOutcome {
  outcome: 'not-saved' | 'partially-saved'
  code: 'invalid-work' | 'jira-unavailable' | 'unconfirmed'
  operation_id: string
  card_id?: string
  message: string
}
interface Receipt { input: string; cardId?: string; handoff?: HandoffReceiptState; review?: ReviewReceiptState; jiraWork?: { dispatched: boolean; outcome?: JiraWorkOutcome }; clawsonMerge?: { plan: ClawsonMergePlan; stagedCardId?: string } }
const writers = new Map<string, Promise<unknown>>()

/** Creation latches and handoff reconciliation state share this receipt store.
 * See docs/features/workflow.md for persistence and retry guarantees; this is
 * never an offline work queue or an authoritative card. */
export class CreationReceipts {
  constructor(private root?: string) {}
  private tail: Promise<unknown> = Promise.resolve()
  private memory: Record<string, Receipt> = {}
  private async read() {
    if (!this.root) return this.memory
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, 'workflow-create-receipts.json'), 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid creation receipts')
      return value as typeof this.memory
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  async get(key: string) { return (await this.read())[key] }
  async entries(prefix: string) { return this.list(prefix) }
  async list(prefix: string) { return Object.entries(await this.read()).filter(([key]) => key.startsWith(prefix)) }
  private change<T>(edit: (values: Record<string, Receipt>) => T) {
    const key = this.root ? join(this.root, 'workflow-create-receipts.json') : undefined
    const result = (key ? writers.get(key) ?? Promise.resolve() : this.tail).catch(() => {}).then(async () => {
      const unlock = this.root ? await acquireLock(join(this.root, 'workflow-create-receipts.lock')) : null
      try {
        const values = await this.read(), updated = edit(values)
        if (!this.root) { this.memory = values; return updated }
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        const path = join(this.root, 'workflow-create-receipts.json'), temp = `${path}.${randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await rename(temp, path)
        return updated
      } finally { await unlock?.() }
    })
    if (key) writers.set(key, result); else this.tail = result
    void result.finally(() => { if (key && writers.get(key) === result) writers.delete(key) }).catch(() => {})
    return result
  }
  put(key: string, input: string, cardId?: string, handoff?: HandoffReceiptState) {
    return this.change(values => { values[key] = { input, ...(cardId ? { cardId } : {}), ...(handoff ? { handoff } : {}) } })
  }
  putJiraWork(key: string, kind: string, dispatched: boolean, outcome?: JiraWorkOutcome) {
    return this.change(values => { values[key] = { input: kind, jiraWork: { dispatched, ...(outcome ? { outcome } : {}) } } })
  }
  putClawsonMerge(key: string, input: string, plan: ClawsonMergePlan, stagedCardId?: string) {
    return this.change(values => {
      const prior = values[key]
      // Keep the first prepared click and a receipt another process already finalized.
      if (prior && (prior.input !== input || !prior.clawsonMerge || !stagedCardId)) return prior
      return values[key] = { input, clawsonMerge: { plan: prior?.clawsonMerge?.plan ?? plan, stagedCardId } }
    })
  }
  remove(key: string) { return this.change(values => { delete values[key] }) }
  putReview(key: string, input: string, cardId: string, review: ReviewReceiptState) {
    return this.change(values => { values[key] = { input, cardId, review } })
  }
}
