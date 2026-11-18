import { createHash } from 'node:crypto'
import type { WorkCard } from './workReader'
import type { CardContextRead } from './cardContext'
import { checkInReport } from './checkInWatchdog'
import { actionableWillCard } from './claimPolicy'

export interface CachedDecisionHistory { context: CardContextRead; observed_at: string; expires_at: string }

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
  const comments = blocks.filter(block => block.type === 'comment' && !checkInReport(block.text) &&
    !block.text.split('\n').at(-1)?.startsWith(deskAnswerMarker) &&
    !block.text.includes('Tin Star prepared packet:') && !block.text.includes('Tin Star operation: ["waiting-on-main",'))
    .map(block => prose(block.text)).filter(Boolean).sort()
  return createHash('sha256').update(canonical([decisionProperties(card), body, comments])).digest('hex')
}

export function decisionCardSource(card: WorkCard, blocks: CardContextRead['blocks']) {
  const title = String(value(card, 'Name') || 'Decision card')
  return {
    card,
    title,
    question: String(value(card, 'Next action') || value(card, 'Next Action') || value(card, 'Waiting For') || title),
    propertyRevision: decisionPropertyRevision(card),
    revision: decisionCardRevision(card, blocks),
    actionable: actionableWillCard(card),
  }
}
export type DecisionCardSource = ReturnType<typeof decisionCardSource>
