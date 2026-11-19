import { createHash } from 'node:crypto'
import type { WorkCard } from './workReader'
import { hasUnverifiedRetractions, requestHistory, type CardContextRead } from './cardContext'
import { checkInReport } from './checkInWatchdog'
import { isJiraCard } from '../../shared/workIdentity'
import { decisionRecordRows, isDecisionRetraction, workflowReceipt } from '../../shared/workflowRequests'
import { mergeActionText } from './queuePulls'
import { reviewResponsePrefix, reviewSubmissions } from '../../shared/reviews'
import { actionableWillCard, currentWillRequests, deferredDecisionCard } from './claimPolicy'

export const deskAnswerMarker = 'Tin Star Desk answer: '
const value = (card: WorkCard, name: string) => card.properties[name]?.value
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)

const decisionFields = ['Name', 'Owner', 'Status', 'Will action', 'Waiting For', 'Waiting For Type', 'Waiting For ID',
  'Next action', 'Next Action', 'Link', 'Evidence', 'GitHub', 'GitHub PRs', 'Pull requests',
  'Initiative', 'Epic', 'Area', 'Sub-area', 'Parent item', 'Requires production verification']

function decisionProperties(card: WorkCard) {
  return Object.fromEntries(decisionFields.map(name => {
    const raw = value(card, name)
    return [name, Array.isArray(raw) ? [...raw].sort() : raw ?? null]
  }))
}

export const decisionPropertyRevision = (card: WorkCard) => createHash('sha256').update(canonical(decisionProperties(card))).digest('hex')

function decisionCardRevision(card: WorkCard, blocks: CardContextRead['blocks']) {
  const prose = (text: string) => text.replace(/\r\n?/g, '\n').trim()
  const body = blocks.filter(block => block.type !== 'comment').map(block => [block.type, prose(block.text)])
  const comments = blocks.filter(block => block.type === 'comment' && (isDecisionRetraction(block.text) && workflowReceipt(block) ||
    !checkInReport(block.text) &&
    !block.text.split('\n').at(-1)?.startsWith(deskAnswerMarker) &&
    !block.text.includes('Tin Star prepared packet:') && !block.text.includes('Tin Star operation: ["waiting-on-main",')))
    .map(block => prose(block.text)).filter(Boolean).sort()
  return createHash('sha256').update(canonical([decisionProperties(card), body, comments])).digest('hex')
}

export const actionableDecisionCard = (card: WorkCard) => !card.source?.synthetic && !isJiraCard(card.id) && actionableWillCard(card)

const prepStatusExcluded = (status: unknown) => ['waiting for prod release', 'delegated to person', 'completed', 'answered', 'resolved', 'merged'].includes(String(status ?? '').trim().toLowerCase())

/** `[TEST ...]` titles are scripted fixtures, not owner decisions, so preparation must not send them. */
const isTestDecisionCard = (card: WorkCard) => /^\s*\[TEST\b/i.test(String(value(card, 'Name') ?? ''))

export function needsMergeEvidence(card: WorkCard) {
  const actions = value(card, 'Will action')
  return !prepBlocked(card) && (Array.isArray(actions) ? actions : [actions]).some(action =>
    typeof action === 'string' && action.trim().toLowerCase() === 'merge')
}

function prepBlocked(card: WorkCard) {
  return !!card.source?.synthetic || isTestDecisionCard(card) || isJiraCard(card.id) ||
    deferredDecisionCard(card) || prepStatusExcluded(value(card, 'Status'))
}

function prepSendable(card: WorkCard, blocks: CardContextRead['blocks'], openMerge: boolean) {
  if (prepBlocked(card) || hasUnverifiedRetractions({ outcome: 'available', blocks })) return false
  const history = requestHistory(blocks)
  const deskAnswer = history.findLastIndex(note =>
    note.type === 'comment' && note.text.trimEnd().split('\n').at(-1)?.startsWith(deskAnswerMarker))
  const earlierNotes = new Set(history.slice(0, deskAnswer + 1).map(note => note.id))
  openMerge = openMerge && needsMergeEvidence(card)
  const actions = value(card, 'Will action')
  if (currentWillRequests(history, actions).some(request => !request.answered && !earlierNotes.has(request.sourceId) &&
    (request.action.trim().toLowerCase() !== 'merge' || openMerge))) return true
  if (deskAnswer >= 0) return false

  if (value(card, 'Status') === 'Ready for Review') {
    const submission = reviewSubmissions(history).at(-1)
    if (submission && !decisionRecordRows(history, reviewResponsePrefix).some(row => row?.submission_key === submission.submission_key)) return true
  }
  const action = String(value(card, 'Next action') || value(card, 'Next Action') || '').trim()
  return openMerge && mergeActionText(action) &&
    !decisionRecordRows(history, 'Tin Star request: ').some(row => String(row?.action).trim().toLowerCase() === 'merge')
}

export function decisionCardSource(card: WorkCard, blocks: CardContextRead['blocks'], openMerge = false) {
  const title = String(value(card, 'Name') || 'Decision card')
  return {
    card,
    title,
    question: String(value(card, 'Next action') || value(card, 'Next Action') || value(card, 'Waiting For') || title),
    propertyRevision: decisionPropertyRevision(card),
    revision: decisionCardRevision(card, blocks),
    actionable: actionableDecisionCard(card),
    prepEligible: prepSendable(card, blocks, openMerge),
  }
}
export type DecisionCardSource = ReturnType<typeof decisionCardSource>
