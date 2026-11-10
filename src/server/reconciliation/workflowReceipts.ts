import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

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
interface Receipt { input: string; cardId?: string; handoff?: HandoffReceiptState }
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
  async entries(prefix: string) { return Object.entries(await this.read()).filter(([key]) => key.startsWith(prefix)) }
  async get(key: string) { return (await this.read())[key] }
  private change(edit: (values: Record<string, Receipt>) => void) {
    const key = this.root ? join(this.root, 'workflow-create-receipts.json') : undefined
    const result = (key ? writers.get(key) ?? Promise.resolve() : this.tail).catch(() => {}).then(async () => {
      const values = await this.read(); edit(values)
      if (!this.root) { this.memory = values; return }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const path = join(this.root, 'workflow-create-receipts.json'), temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await rename(temp, path)
    })
    if (key) writers.set(key, result); else this.tail = result
    void result.finally(() => { if (key && writers.get(key) === result) writers.delete(key) }).catch(() => {})
    return result
  }
  put(key: string, input: string, cardId?: string, handoff?: HandoffReceiptState) {
    return this.change(values => { values[key] = { input, ...(cardId ? { cardId } : {}), ...(handoff ? { handoff } : {}) } })
  }
  remove(key: string) { return this.change(values => { delete values[key] }) }
}
