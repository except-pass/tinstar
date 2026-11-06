import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { releasePull, type AssociationEvent } from '../../shared/releases'
import { getConfigRoot } from '../configRoot'

export const associationInput = z.object({
  id: z.string().uuid(), pull: z.string().transform(value => releasePull(value)?.url ?? '').refine(Boolean, 'Expected GitHub PR URL'),
  cardId: z.string().regex(/^[a-f0-9]{32}$/), action: z.enum(['link', 'unlink']), reason: z.string().trim().min(1).max(1000),
})
const eventSchema = associationInput.extend({ actor: z.string().min(1), at: z.string().datetime() })
const storeSchema = z.object({ version: z.literal(1), events: z.array(eventSchema) })
export class AssociationConflict extends Error {}
/** Single server config-root writer. Atomic replacement preserves the previous audit on failure. */
export class AssociationStore {
  private pending: Promise<unknown> = Promise.resolve()
  private file: string
  constructor(private root = getConfigRoot()) { this.file = join(root, 'releases', 'associations.json') }
  async read(): Promise<AssociationEvent[]> {
    try { return storeSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).events }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  append(input: z.infer<typeof associationInput>, actor: string) {
    const work = this.pending.then(async () => {
      const parsed = associationInput.parse(input), events = await this.read()
      const existing = events.find(event => event.id === parsed.id)
      if (existing) {
        if (existing.pull !== parsed.pull || existing.cardId !== parsed.cardId || existing.action !== parsed.action || existing.reason !== parsed.reason || existing.actor !== actor) throw new AssociationConflict('Association request ID already has different content')
        return existing
      }
      const event = eventSchema.parse({ ...parsed, actor, at: new Date().toISOString() })
      await mkdir(join(this.root, 'releases'), { recursive: true })
      const temporary = `${this.file}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, events: [...events, event] }, null, 2) + '\n', { mode: 0o600 })
        await rename(temporary, this.file)
      } catch { throw new Error('Association audit could not be saved') }
      return event
    })
    this.pending = work.catch(() => {})
    return work
  }
}
