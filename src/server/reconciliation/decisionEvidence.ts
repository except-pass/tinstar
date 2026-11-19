import { createHash } from 'node:crypto'
import type { WorkCard } from './workReader'
import { hasUnverifiedRetractions, requestHistory, type CardContextRead } from './cardContext'
import { checkInReport } from './checkInWatchdog'
import { isJiraCard } from '../../shared/workIdentity'
import { isDecisionRetraction, workflowReceipt } from '../../shared/workflowRequests'
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

const prepStatusExcluded = (status: unknown) => ['waiting for prod release', 'delegated to person'].includes(String(status ?? '').trim().toLowerCase())

/** `[TEST ...]` titles are scripted fixtures, not owner decisions, so preparation must not send them. */
const isTestDecisionCard = (card: WorkCard) => /^\s*\[TEST\b/i.test(String(value(card, 'Name') ?? ''))

function openOwnerDecisionRequests(card: WorkCard, blocks: CardContextRead['blocks']) {
  // Unverified withdrawals are not a request list. The Desk hides them the same way.
  if (hasUnverifiedRetractions({ outcome: 'available', blocks })) return []
  return currentWillRequests(requestHistory(blocks), value(card, 'Will action')).filter(request => !request.answered)
}

function prepBlocked(card: WorkCard) {
  return !!card.source?.synthetic || isTestDecisionCard(card) || isJiraCard(card.id) ||
    deferredDecisionCard(card) || prepStatusExcluded(value(card, 'Status'))
}

/** Who preparation may send. Claim and answer still use actionableDecisionCard. */
function prepSendable(card: WorkCard, blocks: CardContextRead['blocks']) {
  if (prepBlocked(card)) return false
  return openOwnerDecisionRequests(card, blocks).length > 0
}

export function decisionCardSource(card: WorkCard, blocks: CardContextRead['blocks']) {
  const title = String(value(card, 'Name') || 'Decision card')
  return {
    card,
    title,
    question: String(value(card, 'Next action') || value(card, 'Next Action') || value(card, 'Waiting For') || title),
    propertyRevision: decisionPropertyRevision(card),
    revision: decisionCardRevision(card, blocks),
    actionable: actionableDecisionCard(card),
    prepEligible: prepSendable(card, blocks),
  }
}
export type DecisionCardSource = ReturnType<typeof decisionCardSource>
