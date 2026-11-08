import { z } from 'zod'
import { organizerSchema, statusFilterSchema } from './reconciliationCommands'

export const pageIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const askViewSchema = z.object({
  scene: z.enum(['overview', 'pulls', 'releases']), organizer: organizerSchema.optional(), statusFilter: statusFilterSchema.optional(),
  query: z.string().max(512).optional(), sort: z.string().max(64).optional(), descending: z.boolean().optional(),
  filter: z.string().max(64).optional(), preset: z.enum(['initiative', 'repository']).optional(), collapsed: z.array(z.string().max(2048)).max(500).optional(),
}).strict()
export type AskView = z.infer<typeof askViewSchema>
export const pullIdSchema = z.string().max(512).regex(/^[\w.-]+\/[\w.-]+#[1-9]\d*$/).transform(value => value.toLowerCase())
const headSchema = z.string().regex(/^[a-f0-9]{40,64}$/)
const overviewTargetSchema = z.object({ kind: z.enum(['execution', 'claim']), id: z.string().min(1).max(2048) }).strict()
const pullTargetSchema = z.object({ kind: z.literal('pull'), id: pullIdSchema, head: headSchema.optional() }).strict()
const releaseTargetSchema = z.object({ kind: z.literal('release'), id: pullIdSchema, target: z.string().min(1).max(256), component: z.string().min(1).max(256) }).strict()
const receiptTargetSchema = releaseTargetSchema.extend({ kind: z.literal('receipt'), receipt_id: z.string().min(1).max(2048) }).strict()
export const askTargetSchema = z.union([overviewTargetSchema, pullTargetSchema, releaseTargetSchema, receiptTargetSchema])
export type AskTarget = z.infer<typeof askTargetSchema>
export type ArtifactAskTarget = Exclude<AskTarget, z.infer<typeof overviewTargetSchema>>
export const isArtifactTarget = (target: AskTarget | undefined): target is ArtifactAskTarget => !!target && ['pull', 'release', 'receipt'].includes(target.kind)
export const askReturnSchema = z.object({
  section: z.enum(['overview', 'pulls', 'releases']),
  target: z.union([z.object({ kind: z.literal('card'), id: pageIdSchema }).strict(), askTargetSchema]),
  view: askViewSchema.optional(),
}).strict().refine(value => value.section === 'overview' ? ['card', 'execution', 'claim'].includes(value.target.kind) : value.section === 'pulls' ? value.target.kind === 'pull' : isArtifactTarget(value.target as AskTarget), 'Return section must own its target')
export type AskReturn = z.infer<typeof askReturnSchema>
export function pullSource(id: string) {
  const match = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(id)
  return match ? { repository: match[1]!.toLowerCase(), number: Number(match[2]), url: `https://github.com/${match[1]!.toLowerCase()}/pull/${match[2]}` } : null
}
export const askFieldSchema = z.enum(['next_check_in', 'status', 'waiting_for', 'owner', 'priority', 'last_edited', 'relationship', 'title', 'ci', 'review', 'changes', 'description', 'deployment', 'receipt'])
export type AskField = z.infer<typeof askFieldSchema>
const semanticContext = {
  field_key: askFieldSchema.optional(), field_value: z.string().max(4000).optional(),
}
export const askContextSchema = z.object({
  anchor: z.object({ kind: z.enum(['work', 'worker', 'link', 'pull', 'release', 'receipt']), page_id: z.string().min(1).max(2048), label: z.string().max(512), url: z.string().url().nullable(), observed_at: z.string().nullable(), freshness: z.enum(['fresh', 'partial', 'stale', 'unknown']).default('unknown'), expires_at: z.string().nullable().default(null) }).strict(),
  view: askViewSchema, target: askTargetSchema.optional(), ...semanticContext,
  schema_version: z.literal(2).optional(), return_to: askReturnSchema.optional(),
  source: z.object({ kind: z.enum(['github', 'deployment']), repository: z.string(), number: z.number().int().positive(),
    head: headSchema.nullable(), merge_sha: headSchema.nullable().optional(), target: z.string().optional(), component: z.string().optional(),
    receipt_id: z.string().optional(), receipt_url: z.string().url().optional(), workflow_url: z.string().url().optional(),
    deployed_sha: z.string().nullable().optional(), observed_at: z.string().nullable(),
  }).strict().optional(),
  relationship: z.object({ claim_id: z.string().max(2048), card_id: pageIdSchema, execution_id: z.string().max(2048), sources: z.array(z.string()), basis: z.enum(['explicit', 'inferred', 'textual']), verification: z.enum(['confirmed', 'unverified', 'conflicting']) }).strict().optional(),
}).strict()
export type AskContext = z.infer<typeof askContextSchema>
/** Legacy records keep their original wire shape; navigation derives the same Overview origin. */
export function askReturn(context: AskContext): AskReturn {
  if (context.return_to) return context.return_to
  if (isArtifactTarget(context.target)) return { section: context.view.scene === 'releases' || context.target.kind !== 'pull' ? 'releases' : 'pulls', target: context.target, view: context.view }
  return { section: 'overview', target: context.target?.kind === 'execution' || context.target?.kind === 'claim' ? context.target : { kind: 'card', id: context.anchor.page_id } }
}
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
