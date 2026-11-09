import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { askRecordSchema, askReplySchema, askActionSelectionSchema, askSelectionInputSchema, conversationTurns, jsonBytes, askBody, inboxRequestId, type AskRecord, type AskContext, type BridgeUpdate, type AskActionSelection, type AskSelectionInput } from '../../shared/ask'

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
      const previous = rows.find(row => row.owner === owner && (row.client_key === clientKey || row.client_key_aliases?.includes(clientKey)))
      if (previous) {
        if (previous.action_selection || previous.question !== question || previous.context.anchor.page_id !== context.anchor.page_id || previous.context.anchor.kind !== context.anchor.kind ||
          JSON.stringify(previous.context.target) !== JSON.stringify(context.target) ||
          (previous.follow_up_to !== undefined ? previous.follow_up_to !== (followUpTo ?? null) : followUpTo && rows.find(row => row.request_id === followUpTo && row.owner === owner)?.conversation_id !== previous.conversation_id)) throw new AskConflict('Retry key belongs to another question')
        return previous
      }
      const parent = followUpTo ? rows.find(row => row.request_id === followUpTo && row.owner === owner) : null
      if (followUpTo && !parent) throw new AskNotFound('Original question unavailable')
      return this.appendRequest(rows, owner, clientKey, question, parent?.context ?? context, parent)
    })
  }
  private appendRequest(rows: AskRecord[], owner: string, clientKey: string, question: string, context: AskContext, parent?: AskRecord | null, selection?: AskActionSelection) {
    const requestId = randomUUID(), at = this.now()
    const row: AskRecord = {
      request_id: requestId, conversation_id: parent?.conversation_id ?? requestId, owner, client_key: clientKey,
      follow_up_to: parent?.request_id ?? null, ...(selection ? { action_selection: selection } : {}),
      question, input_mode: 'text', context, created_at: at, updated_at: at,
      status: 'sent', answered_at: null, note_id: null, announced: null, reply: null, reply_cursor: null, error: null, read_at: null, dismissed_at: null,
    }
    row.dispatch_body = askBody(row, conversationTurns(rows.filter(previous => previous.owner === owner && previous.conversation_id === row.conversation_id)))
    rows.push(row)
    return row
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
  async conversation(conversationId: string, owner?: string) {
    await this.writing
    const rows = (await this.load()).filter(row => row.conversation_id === conversationId && (owner === undefined || row.owner === owner))
    if (!rows.length) throw new AskNotFound('Conversation unavailable')
    return { schema: 'tinstar.ask-conversation.v1' as const, conversation_id: conversationId,
      context: structuredClone(rows[0]!.context), turns: structuredClone(conversationTurns(rows)), omitted: null }
  }
  /** Chunk 2 supplies canonical membership lookup from its typed reply actions.
   * The callback runs inside the writer lock; no browser instruction is trusted.
   * A selection is a new bridge request, never an action executed by Tin Star. */
  createActionSelection(owner: string, input: AskSelectionInput, lookupAction: (answer: AskRecord, actionId: string) => { id: string; label: string; instruction: string } | undefined) {
    const selectionInput = askSelectionInputSchema.parse(input)
    return this.change(rows => {
      const { answer_id: answerId, action_id: actionId, client_key: clientKey } = selectionInput
      const previous = rows.find(row => row.owner === owner && (row.client_key === clientKey || row.client_key_aliases?.includes(clientKey)))
      if (previous) {
        if (previous.action_selection?.answer_id !== answerId || previous.action_selection.action_id !== actionId) throw new AskConflict('Retry key belongs to another selection')
        return previous
      }
      const answer = rows.find(row => row.owner === owner && row.request_id === answerId)
      if (!answer?.reply) throw new AskNotFound('Original answer unavailable')
      // Both same-key retries and another device's same-action retry recover the
      // original request even after its answer is superseded by a later reply.
      const consumed = rows.find(row => row.owner === owner && row.action_selection?.answer_id === answerId)
      if (consumed) {
        if (consumed.action_selection!.action_id !== actionId) throw new AskConflict('Another action was already selected for this answer')
        ;(consumed.client_key_aliases ??= []).push(clientKey)
        return consumed
      }
      const replies = conversationTurns(rows.filter(row => row.owner === owner && row.conversation_id === answer.conversation_id)).filter(turn => turn.role === 'assistant')
      if (replies.at(-1)?.request_id !== answerId) throw new AskConflict('Answer has been superseded')
      const action = lookupAction(structuredClone(answer), actionId)
      if (!action || action.id !== actionId) throw new AskNotFound('Action unavailable in the saved answer')
      const selection = askActionSelectionSchema.parse({ selection_id: randomUUID(), answer_id: answerId, action_id: action.id,
        instruction: action.instruction, label: action.label, actor: owner, selected_at: this.now() })
      return this.appendRequest(rows, owner, clientKey, selection.instruction, answer.context, answer, selection)
    })
  }
  async bridgeWork() {
    // Persist legacy payloads on first dispatch too. Capturing under the writer
    // lock freezes each note body before a puller can save it and lose its ack.
    const eligible = (row: AskRecord) => row.status === 'sent' || row.status === 'delivered' && row.announced === false && !row.error
    const collect = (rows: AskRecord[]) => {
      const pending: { request_id: string; inbox_request_id: string; body: string }[] = []
      for (const row of rows) {
        if (!eligible(row)) continue
        row.dispatch_body ??= askBody(row, conversationTurns(rows.slice(0, rows.indexOf(row)).filter(previous => previous.owner === row.owner && previous.conversation_id === row.conversation_id)))
        const entry = { request_id: row.request_id, inbox_request_id: inboxRequestId(row.request_id), body: row.dispatch_body }
        // Includes outer JSON escaping. The old Mac puller reads at most 2 MiB.
        if (pending.length && (pending.length >= 50 || jsonBytes(pending) + jsonBytes(entry) > 1024 * 1024)) break
        pending.push(entry)
      }
      return { pending, tracked: rows.filter(row => row.note_id && !row.reply).map(row => ({ request_id: row.request_id, note_id: row.note_id })) }
    }
    await this.writing
    const rows = await this.load()
    return rows.some(row => eligible(row) && row.dispatch_body === undefined) ? this.change(collect) : collect(rows)
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
