import { z } from 'zod'
import { organizerSchema, statusFilterSchema } from './reconciliationCommands'

export const pageIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const askViewSchema = z.object({
  scene: z.literal('overview'), organizer: organizerSchema.optional(), statusFilter: statusFilterSchema.optional(),
}).strict()
export const askTargetSchema = z.object({ kind: z.enum(['execution', 'claim']), id: z.string().min(1).max(2048) }).strict()
export type AskTarget = z.infer<typeof askTargetSchema>
export const askFieldSchema = z.enum(['next_check_in', 'status', 'waiting_for', 'owner', 'priority', 'last_edited', 'relationship', 'title'])
export type AskField = z.infer<typeof askFieldSchema>
const semanticContext = {
  field_key: askFieldSchema.optional(), field_value: z.string().max(4000).optional(),
}
export const askContextSchema = z.object({
  anchor: z.object({ kind: z.enum(['work', 'worker', 'link']), page_id: z.string().min(1).max(2048), label: z.string().max(512), url: z.string().url().nullable(), observed_at: z.string().nullable(), freshness: z.enum(['fresh', 'partial', 'stale', 'unknown']).default('unknown'), expires_at: z.string().nullable().default(null) }).strict(),
  view: askViewSchema, target: askTargetSchema.optional(), ...semanticContext,
  relationship: z.object({ claim_id: z.string().max(2048), card_id: pageIdSchema, execution_id: z.string().max(2048), sources: z.array(z.string()), basis: z.enum(['explicit', 'inferred', 'textual']), verification: z.enum(['confirmed', 'unverified', 'conflicting']) }).strict().optional(),
}).strict()
export type AskContext = z.infer<typeof askContextSchema>
export const askReplySchema = z.object({
  summary: z.string().min(1).max(2000), detail: z.string().max(32000),
  references: z.array(z.object({ label: z.string().max(512), url: z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  }) })).max(20),
  suggested_actions: z.array(z.string().max(2000)).max(10),
})
export const askRecordSchema = z.object({
  request_id: z.string().uuid(), conversation_id: z.string().uuid(), client_key: z.string().uuid(), owner: z.string(),
  question: z.string().min(1).max(4000), input_mode: z.literal('text'), context: askContextSchema,
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
  status: z.enum(['sent', 'delivered', 'answered', 'failed']), answered_at: z.string().datetime().nullable().default(null),
  note_id: z.string().nullable(), announced: z.boolean().nullable(),
  reply: askReplySchema.nullable(), reply_cursor: z.string().nullable(),
  error: z.string().nullable(), read_at: z.string().datetime().nullable(), dismissed_at: z.string().datetime().nullable(),
})
export type AskRecord = z.infer<typeof askRecordSchema>
export const askItemSchema = askRecordSchema.omit({ owner: true, client_key: true, note_id: true, reply_cursor: true, announced: true })
export const askItemsSchema = z.array(askItemSchema)
export type AskItem = z.infer<typeof askItemSchema>
export const publicAsk = ({ owner: _owner, client_key: _key, note_id: _note, reply_cursor: _cursor, announced: _announced, ...item }: AskRecord): AskItem => item
export const askCreateSchema = z.object({
  client_key: z.string().uuid(), card_id: pageIdSchema.optional(), target: askTargetSchema.optional(), ...semanticContext, question: z.string().trim().min(1).max(4000),
  view: askViewSchema, follow_up_to: z.string().uuid().optional(),
}).strict().refine(input => !!input.card_id !== !!input.target, 'Choose one Ask entity')
export const noteResultSchema = z.object({
  schema: z.literal('fm-inbox-note.v1'), outcome: z.enum(['created', 'replay']),
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/).refine(id => !id.includes('..')),
  request_id: z.string().max(128), saved: z.literal(true), announced: z.boolean().nullable(), acknowledged: z.boolean(),
})
export const bridgeUpdateSchema = z.object({
  request_id: z.string().uuid(), note: noteResultSchema.optional(),
  reply: z.object({ id: z.string().min(1).max(128), at: z.string().datetime(), body: z.string().min(1).max(32000), cursor: z.string().regex(/^\d{1,24}$/) }).optional(),
  // Errors are deliberately a small public vocabulary: never relay script stderr or secrets.
  error: z.enum(['capture-failed', 'wake-failed']).optional(),
}).strict().refine(value => value.note || value.reply || value.error, 'Empty update')
export type BridgeUpdate = z.infer<typeof bridgeUpdateSchema>
export const inboxRequestId = (requestId: string) => `tinstar-ask-${requestId}`
export function askBody(ask: AskRecord): string {
  return `Tin Star question. Investigate using fresh authoritative sources; an answer never authorizes a privileged action. Publish your answer using fm-inbox.sh reply <this-note-id> -. Plain text is supported; for structured evidence use JSON with schema=tinstar.ask-reply.v1, request_id, summary, detail, references=[{label,url}], suggested_actions=[text].\n${JSON.stringify({ schema: 'tinstar.ask.v1', request_id: ask.request_id, conversation_id: ask.conversation_id, requesting_principal: ask.owner, created_at: ask.created_at, question: ask.question, input_mode: ask.input_mode, context: ask.context })}\n`
}
