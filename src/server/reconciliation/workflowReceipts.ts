import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Only uncertain page creations need a local durable latch: unlike property
 * patches/comments they have no caller-supplied Notion identity to retry. This
 * file is a receipt, never an offline work queue or an authoritative card. */
export class CreationReceipts {
  constructor(private root?: string) {}
  private memory: Record<string, { input: string; cardId?: string }> = {}
  private async read() {
    if (!this.root) return this.memory
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, 'workflow-create-receipts.json'), 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid creation receipts')
      return value as typeof this.memory
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  async get(key: string) { return (await this.read())[key] }
  async put(key: string, input: string, cardId?: string) {
    const values = await this.read(); values[key] = { input, ...(cardId ? { cardId } : {}) }
    if (!this.root) { this.memory = values; return }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, 'workflow-create-receipts.json'), temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await rename(temp, path)
  }
  async remove(key: string) {
    const values = await this.read(); delete values[key]
    if (!this.root) { this.memory = values; return }
    const path = join(this.root, 'workflow-create-receipts.json'), temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await rename(temp, path)
  }
}
