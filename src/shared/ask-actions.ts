import { z } from 'zod'

export const askActionIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)

// Actionable suggestions are prose. Reject explicit link/source containers so
// recommendations cannot double as navigation or executable payloads. These
// checks do not authorize an action; instruction text is never interpreted here.
const linkSyntax = /(?:\/\/|\b(?:https?|javascript|data|file|mailto):|\bwww\.|\[[^\]]*\]\s*\(|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|test)(?:\b|\/))/i
const sourceSyntax = /[`{};<>]|\$\(|\$\{|&&|\|\||\s\|\s|(?:^|\s)--?[A-Za-z]|\b(?:eval|exec|require|import|print|alert)\s*\(|\b(?:const|let|var)\s+\w+\s*=|\b\w+(?:\.\w+)*\([^)]*\)|^(?:#!|(?:bash|sh|python\d*|node|curl|wget)\s)/i
const prose = (max: number) => z.string().min(1).max(max).refine(
  value => !!value.trim() && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value) && !linkSyntax.test(value) && !sourceSyntax.test(value.trim()),
  'Use single-line prose without URLs or executable source; put evidence links in references',
).transform(value => value.trim())

export const askActionSchema = z.object({
  id: askActionIdSchema,
  label: prose(64),
  instruction: prose(2000),
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
