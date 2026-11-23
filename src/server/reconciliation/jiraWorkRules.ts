import { z } from 'zod'
const jiraIdentity = /^jira:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net):([1-9]\d*):([1-9]\d*)$/
export const jiraWorkIdentity = (id: string) => {
  const match = jiraIdentity.exec(id)
  return match ? { site: match[1]!, projectId: match[2]!, issueId: match[3]! } : undefined
}
export const jiraWorkIdSchema = z.string().regex(jiraIdentity, 'Use an exact Jira card ID')

export const jiraStatuses = ['Backlog', 'To Do', 'Queued', 'In Progress', 'Decision', 'Waiting For', 'Ready for Review', 'Waiting for Prod Release', 'Verify in Prod', 'Done', 'Canceled'] as const
const status = z.enum(jiraStatuses)
export type JiraStatus = z.infer<typeof status>

export const jiraVerbs = ['Prioritize', 'Queue', 'Fast-track', 'Start', 'Submit for Review', 'Accept Review', 'Accept Final', 'Release Ready', 'Deployed', 'Verify Passed', 'Complete Directly', 'Request Decision', 'Block', 'Answer Decision', 'Resolve Wait', 'Dequeue', 'Deprioritize', 'Stop and Requeue', 'Return for Preparation', 'Reject Review', 'Verification Failed', 'Release Rejected', 'Cancel', 'Reopen', 'Park'] as const
type Verb = typeof jiraVerbs[number]
const work: JiraStatus[] = ['To Do', 'Queued', 'In Progress', 'Ready for Review', 'Waiting for Prod Release', 'Verify in Prod']
const active: JiraStatus[] = [...work, 'Decision', 'Waiting For']
const nonterminal: JiraStatus[] = ['Backlog', ...active]
const decisionExits = ['To Do', 'Queued', 'In Progress', 'Ready for Review', 'Waiting for Prod Release'] as const
const waitExits = [...decisionExits, 'Decision'] as const
const dispositionVerbs = ['Park', 'Cancel', 'Stop and Requeue'] as const
const interruptVerbs = ['Answer Decision', 'Resolve Wait'] as const
const recovery = ['To Do', 'Queued'] as const
const recoveryVerbs = ['Reject Review', 'Verification Failed', 'Release Rejected', 'Reopen'] as const

export const jiraTransitions: Record<Verb, [from: JiraStatus[], to: readonly JiraStatus[]]> = {
  Prioritize: [['Backlog'], ['To Do']],
  Queue: [['To Do'], ['Queued']],
  'Fast-track': [['Backlog'], ['Queued']],
  Start: [['Queued'], ['In Progress']],
  'Submit for Review': [['In Progress'], ['Ready for Review']],
  'Accept Review': [['Ready for Review'], ['Waiting for Prod Release']],
  'Accept Final': [['Ready for Review'], ['Done']],
  'Release Ready': [['In Progress'], ['Waiting for Prod Release']],
  Deployed: [['Waiting for Prod Release'], ['Verify in Prod']],
  'Verify Passed': [['Verify in Prod'], ['Done']],
  'Complete Directly': [['In Progress'], ['Done']],
  'Request Decision': [active.filter(value => value !== 'Decision'), ['Decision']],
  Block: [active.filter(value => value !== 'Waiting For'), ['Waiting For']],
  'Answer Decision': [['Decision'], [...decisionExits, 'Verify in Prod']],
  'Resolve Wait': [['Waiting For'], [...waitExits, 'Verify in Prod']],
  Dequeue: [['Queued'], ['To Do']],
  Deprioritize: [['To Do'], ['Backlog']],
  'Stop and Requeue': [['In Progress'], ['Queued']],
  'Return for Preparation': [['Queued', 'In Progress'], ['To Do']],
  'Reject Review': [['Ready for Review'], recovery],
  'Verification Failed': [['Verify in Prod'], recovery],
  'Release Rejected': [['Waiting for Prod Release'], recovery],
  Cancel: [nonterminal, ['Canceled']],
  Reopen: [['Done', 'Canceled'], recovery],
  Park: [active, ['Backlog']],
}

const prose = z.string().trim().min(1)
const multiline = prose.transform(value => value.replace(/\r\n?/g, '\n'))
const singleLine = prose.regex(/^[^\r\n]+$/, 'Use one line')
const nativeId = z.string().regex(/^[1-9]\d*$/)
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9]\d*$/)
const decisionId = z.string().regex(/^D[1-9]\d*$/)
const issueType = z.enum(['Task', 'Epic'])
const operation = z.string().min(1).max(128)
const question = z.object({ id: decisionId, question: multiline, options: z.array(multiline).optional(), answer: multiline.optional() }).strict()
export type JiraDecision = z.infer<typeof question>
const externalBlocker = z.object({
  type: z.enum(['Actor', 'Event']),
  target: singleLine.regex(/^[^\s]+$/, 'Use a canonical external identifier'),
  unblocks_when: multiline,
}).strict()
export type JiraExternalBlocker = z.infer<typeof externalBlocker>

export const jiraCreateSchema = z.object({
  provider: z.literal('jira'), operation_id: operation, name: singleLine.max(255), owner: singleLine.optional(),
  description: multiline.optional(), issue_type: issueType.optional(),
}).strict()
export const jiraEditSchema = z.object({
  kind: z.literal('jira_edit'), card_id: jiraWorkIdSchema, operation_id: operation,
  name: singleLine.max(255).optional(), description: multiline.nullable().optional(), owner: singleLine.nullable().optional(),
  add_questions: z.array(question.omit({ answer: true })).min(1).optional(),
  answers: z.array(z.object({ id: decisionId, answer: multiline }).strict()).min(1).optional(),
  blocker: externalBlocker.nullable().optional(), note: multiline.optional(),
}).strict()
const transitionArguments = z.object({
  card_id: jiraWorkIdSchema, operation_id: operation, verb: z.enum(jiraVerbs),
  reason: multiline.optional(), evidence: multiline.optional(),
})
const revisions = { required_revision: singleLine.optional(), live_revision: singleLine.optional() }
export const jiraTransitionSchema = z.union([
  transitionArguments.extend({ verb: z.literal('Deployed'), ...revisions }).strict(),
  transitionArguments.extend({ verb: z.enum(interruptVerbs), to: z.literal('Verify in Prod'), ...revisions }).strict(),
  transitionArguments.extend({ verb: z.literal('Answer Decision'), to: z.enum(decisionExits) }).strict(),
  transitionArguments.extend({ verb: z.literal('Resolve Wait'), to: z.enum(waitExits) }).strict(),
  transitionArguments.extend({ verb: z.enum(recoveryVerbs), to: z.enum(recovery) }).strict(),
  transitionArguments.extend({ verb: z.enum(dispositionVerbs), disposition: multiline.optional() }).strict(),
  transitionArguments.extend({ verb: z.enum(jiraVerbs).exclude(['Deployed', ...interruptVerbs, ...dispositionVerbs, ...recoveryVerbs]) }).strict(
    'Revision arguments are only accepted for Deployed or an interrupt exit into Verify in Prod',
  ),
])
export const jiraLinkSchema = z.object({
  card_id: jiraWorkIdSchema, operation_id: operation, action: z.enum(['add', 'remove']),
  target_key: jiraKey.optional(), type: singleLine.optional(),
  direction: z.enum(['outward', 'inward']).optional(), link_id: nativeId.optional(),
}).strict()

export type JiraCreate = z.infer<typeof jiraCreateSchema>
export type JiraEdit = z.infer<typeof jiraEditSchema>
export type JiraTransition = z.infer<typeof jiraTransitionSchema>
export type JiraLink = z.infer<typeof jiraLinkSchema>
export class JiraWorkInputError extends Error {}

const header = /^(D[1-9]\d*) (\[Open\]|\[Answered\]): (.*)$/
function decisionBlocks(text: string) {
  if (!text.trim()) return []
  return text.trimEnd().replace(/\r\n/g, '\n').split(/\n(?=D[1-9]\d* \[(?:Open|Answered)\]:)/).map(block => {
    const [first = '', ...lines] = block.trimEnd().split('\n')
    const match = header.exec(first)
    if (!match) throw new JiraWorkInputError('Decision Questions must use D1 [Open]: … headers and indented options or answers.')
    const [, id, state, prompt] = match
    const options: string[] = []
    let answer: string | undefined
    let current = { value: prompt ?? '', kind: 'question' }
    const flush = () => {
      if (current.kind === 'option') options.push(current.value)
      if (current.kind === 'answer') {
        if (answer !== undefined) throw new JiraWorkInputError(`Question ${id} has multiple answers`)
        answer = current.value
      }
    }
    let questionText = current.value
    for (const line of lines) {
      const field = /^  (Option|Answer): (.*)$/.exec(line)
      if (field) {
        if (current.kind === 'question') questionText = current.value
        flush()
        current = { kind: field[1] === 'Option' ? 'option' : 'answer', value: field[2] ?? '' }
      } else if (line.startsWith('    ')) current.value += '\n' + line.slice(4)
      else throw new JiraWorkInputError(`Invalid Decision Questions line in ${id}`)
    }
    if (current.kind === 'question') questionText = current.value
    flush()
    const parsed = question.safeParse({ id, question: questionText, ...(options.length ? { options } : {}), ...(answer === undefined ? {} : { answer }) })
    if (!parsed.success || (state === '[Answered]') !== (answer !== undefined)) throw new JiraWorkInputError(`Invalid question or answer state in ${id}`)
    return parsed.data
  })
}

export function readJiraDecisions(text: string): JiraDecision[] {
  // Blank separator lines are optional. Continuations within a value are indented.
  const decisions = decisionBlocks(text.replace(/\r\n/g, '\n').replace(/\n\n+(?=D[1-9]\d* \[)/g, '\n'))
  if (new Set(decisions.map(item => item.id)).size !== decisions.length) throw new JiraWorkInputError('Duplicate Decision question IDs')
  return decisions
}

export function formatJiraDecisions(items: JiraDecision[]) {
  const multiline = (value: string) => value.replace(/\r\n/g, '\n').replace(/\n/g, '\n    ')
  return items.map(item => [
    `${item.id} [${item.answer ? 'Answered' : 'Open'}]: ${multiline(item.question)}`,
    ...(item.options ?? []).map(option => `  Option: ${multiline(option)}`),
    ...(item.answer ? [`  Answer: ${multiline(item.answer)}`] : []),
  ].join('\n')).join('\n\n')
}

export function editJiraDecisions(text: string, { add_questions = [], answers = [] }: Pick<JiraEdit, 'add_questions' | 'answers'>) {
  const prior = readJiraDecisions(text)
  const items = new Map(prior.map(item => [item.id, item]))
  for (const item of add_questions) {
    if (items.has(item.id)) throw new JiraWorkInputError(`Question ${item.id} already exists`)
    items.set(item.id, item)
  }
  for (const { id, answer } of answers) {
    const item = items.get(id)
    if (!item) throw new JiraWorkInputError(`Unknown question ${id}`)
    if (item.answer !== undefined) throw new JiraWorkInputError(`Question ${id} is already answered`)
    items.set(id, { ...item, answer })
  }
  return formatJiraDecisions([...items.values()])
}

export function jiraTransitionDestination(input: JiraTransition) {
  const [, destinations] = jiraTransitions[input.verb]
  if ('to' in input) return destinations.includes(input.to) ? input.to : undefined
  return destinations.length === 1 ? destinations[0] : undefined
}

type State = { status: string; owner: string | null; instructionText: string; decisions: string; blocker: boolean }
export function checkJiraTransition(current: State, input: JiraTransition) {
  const [from, destinations] = jiraTransitions[input.verb]
  const to = jiraTransitionDestination(input)
  if (!to || !from.includes(current.status as JiraStatus)) {
    throw new JiraWorkInputError(`${input.verb} is unavailable from ${current.status}; choose an allowed destination: ${destinations.join(', ')}`)
  }
  if (active.includes(to) && !current.owner) throw new JiraWorkInputError('Choose an Owner before entering a work status')
  if (current.blocker && work.includes(to) && to !== 'To Do') {
    throw new JiraWorkInputError('Clear the primary blocker before resuming work')
  }
  if ((to === 'Queued' || to === 'In Progress') && !current.instructionText.trim()) {
    throw new JiraWorkInputError('Queue and Start require instructions and a clear success condition')
  }
  if ((['In Progress', 'Ready for Review', 'Waiting for Prod Release', 'Verify in Prod'].includes(to) || ['Accept Final', 'Verify Passed', 'Complete Directly', 'Resolve Wait'].includes(input.verb)) && !input.evidence) {
    throw new JiraWorkInputError(`${input.verb} requires evidence of the stated outcome`)
  }
  if (['Reject Review', 'Verification Failed', 'Release Rejected', 'Cancel', 'Reopen'].includes(input.verb) && !input.reason) {
    throw new JiraWorkInputError(`${input.verb} requires a reason`)
  }
  if (dispositionVerbs.some(verb => verb === input.verb) && !('disposition' in input && input.disposition)) {
    throw new JiraWorkInputError(`${input.verb} requires the disposition of any live work`)
  }
  if (to === 'Verify in Prod' && (!('required_revision' in input) || !input.required_revision || input.required_revision !== input.live_revision)) {
    throw new JiraWorkInputError('Verify in Prod requires the exact required revision verified live')
  }
  if (to === 'Decision' && !readJiraDecisions(current.decisions).some(item => item.answer === undefined)) {
    throw new JiraWorkInputError('Add at least one open Decision question before requesting a decision')
  }
  if (input.verb === 'Answer Decision') {
    const items = readJiraDecisions(current.decisions)
    if (!items.length || items.some(item => item.answer === undefined)) throw new JiraWorkInputError('All Decision questions must be answered before leaving Decision with Answer Decision')
  }
  if (input.verb === 'Block' && !current.blocker) throw new JiraWorkInputError('Set a primary blocker before blocking the ticket')
  if (input.verb === 'Resolve Wait' && current.blocker) throw new JiraWorkInputError('Clear the primary blocker after it resolves')
  return to
}
