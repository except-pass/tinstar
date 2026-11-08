import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { askRecordSchema, askReplySchema, askBody, inboxRequestId, type AskRecord, type AskContext, type BridgeUpdate } from '../../shared/ask'

export class AskConflict extends Error {}
export class AskNotFound extends Error {}

/** One server owns this store. Atomic replacement and a serialized writer keep
 * retries and concurrent bridge/browser writes from losing accepted messages.
 * Ask history has no automatic pruning; it is independent of fleet-outbox.json.
 */
export class AskStore {
  private rows: AskRecord[] | null = null
  private writing: Promise<unknown> = Promise.resolve()
  constructor(private root: string, private now = () => new Date().toISOString()) {}
  private async load() {
    if (!this.rows) {
      try { this.rows = z.array(askRecordSchema).parse(JSON.parse(await readFile(join(this.root, 'ask-requests.json'), 'utf8'))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.rows = []
      }
    }
    return this.rows
  }
  private change<T>(operation: (rows: AskRecord[]) => T): Promise<T> {
    const task = this.writing.then(async () => {
      const rows = structuredClone(await this.load())
      const result = operation(rows)
      await mkdir(this.root, { recursive: true })
      const path = join(this.root, 'ask-requests.json'), temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(rows), { mode: 0o600 })
      await rename(temp, path)
      this.rows = rows
      return result
    })
    this.writing = task.catch(() => undefined)
    return task
  }
  async list(owner: string) {
    await this.writing
    return structuredClone((await this.load()).filter(row => row.owner === owner))
  }
  async find(owner: string, requestId: string) { return (await this.list(owner)).find(row => row.request_id === requestId) }
  create(owner: string, clientKey: string, question: string, context: AskContext, followUpTo?: string) {
    return this.change(rows => {
      const previous = rows.find(row => row.owner === owner && row.client_key === clientKey)
      if (previous) {
        if (previous.question !== question || previous.context.anchor.page_id !== context.anchor.page_id || previous.context.anchor.kind !== context.anchor.kind ||
          JSON.stringify(previous.context.target) !== JSON.stringify(context.target) ||
          (followUpTo && rows.find(row => row.request_id === followUpTo && row.owner === owner)?.conversation_id !== previous.conversation_id)) throw new AskConflict('Retry key belongs to another question')
        return previous
      }
      const parent = followUpTo ? rows.find(row => row.request_id === followUpTo && row.owner === owner) : null
      if (followUpTo && !parent) throw new AskNotFound('Original question unavailable')
      const requestId = randomUUID(), at = this.now()
      const row: AskRecord = {
        request_id: requestId, conversation_id: parent?.conversation_id ?? requestId, owner, client_key: clientKey,
        question, input_mode: 'text', context: parent?.context ?? context, created_at: at, updated_at: at,
        status: 'sent', answered_at: null, note_id: null, announced: null, reply: null, reply_cursor: null, error: null, read_at: null, dismissed_at: null,
      }
      rows.push(row)
      return row
    })
  }
  action(owner: string, requestId: string, action: 'read' | 'dismiss' | 'retry') {
    return this.change(rows => {
      const row = rows.find(row => row.request_id === requestId && row.owner === owner)
      if (!row) throw new AskNotFound('Question unavailable')
      if (action === 'read' && row.reply) row.read_at ??= this.now()
      if (action === 'dismiss') row.dismissed_at ??= this.now()
      if (action === 'retry' && !row.reply) { row.status = row.note_id ? 'delivered' : 'sent'; row.error = null }
      row.updated_at = this.now()
      return row
    })
  }
  async bridgeWork() {
    await this.writing
    const rows = await this.load()
    return {
      pending: rows.filter(row => row.status === 'sent' || row.status === 'delivered' && row.announced === false && !row.error).slice(0, 50)
        .map(row => ({ request_id: row.request_id, inbox_request_id: inboxRequestId(row.request_id), body: askBody(row) })),
      tracked: rows.filter(row => row.note_id && !row.reply).map(row => ({ request_id: row.request_id, note_id: row.note_id })),
    }
  }
  ingest(update: BridgeUpdate) {
    return this.change(rows => {
      const row = rows.find(row => row.request_id === update.request_id)
      if (!row) throw new AskNotFound('Unknown request')
      if (update.note) {
        if (update.note.request_id !== inboxRequestId(row.request_id) || row.note_id && row.note_id !== update.note.id ||
          rows.some(other => other.request_id !== row.request_id && other.note_id === update.note!.id)) throw new AskConflict('Note does not match request')
        row.note_id = update.note.id
        // A delayed capture result may not overwrite a repaired wake or an answer.
        row.announced = row.announced === true || update.note.announced === true ? true : update.note.announced
        if (!row.reply) { row.status = 'delivered'; row.error = row.announced === false ? 'First Mate saved the question but was not woken. Retry delivery.' : null }
      }
      if (update.reply) {
        if (update.reply.id !== row.note_id) throw new AskConflict('Reply does not match saved note')
        if (row.reply_cursor && BigInt(update.reply.cursor) <= BigInt(row.reply_cursor)) return row
        // fm-inbox permits one immutable answer per note. A later conflicting
        // answer is a protocol error, never a silent overwrite of read history.
        if (row.reply) throw new AskConflict('Answer already recorded')
        let parsed: unknown
        try { parsed = JSON.parse(update.reply.body) } catch { /* ordinary primary text reply */ }
        if (parsed && typeof parsed === 'object' && 'schema' in parsed && parsed.schema === 'tinstar.ask-reply.v1') {
          if (!('request_id' in parsed) || parsed.request_id !== row.request_id) throw new AskConflict('Structured reply request does not match')
          row.reply = askReplySchema.parse(parsed)
        } else {
          row.reply = { summary: update.reply.body.slice(0, 240), detail: update.reply.body, references: [], suggested_actions: [] }
        }
        row.reply_cursor = update.reply.cursor
        row.status = 'answered'; row.answered_at = update.reply.at; row.read_at = null; row.error = null
      }
      if (update.error && !row.reply && !(row.note_id && update.error === 'capture-failed')) {
        row.error = update.error === 'wake-failed' ? 'First Mate saved the question but was not woken. Retry delivery.' : 'First Mate could not receive the question. Retry delivery.'
        if (!row.note_id) row.status = 'failed'
      }
      row.updated_at = this.now()
      return row
    })
  }
}
