import { z } from 'zod'
import { releasePull } from './releases'

export const askActionIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)

// Action instructions are inert prose, never executed. Reject links, HTML and
// backticks so a suggestion stays a plain-text button rather than a container.
const linkSyntax = /(?:\/\/|\b(?:https?|javascript|data|file|mailto):|\bwww\.|\[[^\]]*\]\s*\(|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|test)(?:\b|\/))/i
const htmlSyntax = /<\/?[a-z][^>]*>|<!--[^>]*-->|<![a-z][^>]*>/i
const prose = (max: number) => z.string().min(1).max(max)
  .refine(value => !!value.trim(), 'Use nonblank prose')
  .refine(value => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value), 'Control characters and line separators are not allowed')
  .refine(value => !value.includes('`'), 'Backticks and code fences are not allowed')
  .refine(value => !htmlSyntax.test(value), 'HTML tags are not allowed')
  .refine(value => !linkSyntax.test(value), 'URLs and link syntax are not allowed; put URLs in references')
  .transform(value => value.trim())

// One optional merge target. The head is read when the owner clicks, never taken from the suggestion.
const githubPullUrl = z.string().refine(value => releasePull(value) !== null, 'pr_url must be a GitHub pull request URL').transform(value => releasePull(value)!.url)
export const askMergeTargetSchema = z.object({ pr_url: githubPullUrl }).strict()
export const askActionSchema = z.object({
  id: askActionIdSchema,
  label: prose(64),
  instruction: prose(2000),
  merge: askMergeTargetSchema.optional(),
}).strict()
export type AskAction = z.infer<typeof askActionSchema>

// Keep historical text exactly as stored. It is inert text, never a button.
export const askSuggestionSchema = z.union([z.string().max(2000), askActionSchema])
export type AskSuggestion = z.infer<typeof askSuggestionSchema>
export const findSuggestedAction = (suggestions: AskSuggestion[], actionId: string): AskAction | undefined =>
  suggestions.find((suggestion): suggestion is AskAction => typeof suggestion !== 'string' && suggestion.id === actionId)
export const askSuggestionsSchema = z.array(askSuggestionSchema).max(10).superRefine((suggestions, ctx) => {
  const ids = new Set<string>()
  suggestions.forEach((suggestion, index) => {
    if (typeof suggestion === 'string') return
    if (ids.has(suggestion.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Action IDs must be unique within an answer' })
    ids.add(suggestion.id)
  })
})
