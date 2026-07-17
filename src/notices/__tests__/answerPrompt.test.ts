import { describe, it, expect } from 'vitest'
import type { Notice } from '../../domain/types'
import { answerPromptText } from '../answerPrompt'

function notice(over: Partial<Notice> = {}): Notice {
  return {
    id: 'notice-1',
    runId: 'CLD-run-1',
    kind: 'needs-you',
    headline: 'Deploy or wait?',
    createdAt: 1,
    amendedAt: 1,
    ...over,
  }
}

const labels = new Map([['opt-a', 'Deploy now'], ['opt-b', 'Wait for review']])

describe('answerPromptText', () => {
  it('renders a needs-you answer with the chosen option label and free text', () => {
    const p = answerPromptText(notice({ answer: { choices: ['opt-a'], text: 'go for it', answeredAt: 2 } }), labels)
    expect(p).toContain('The user answered your Roundup notice "Deploy or wait?"')
    expect(p).toContain('notice notice-1')
    expect(p).toContain('They chose: Deploy now') // id resolved to label
    expect(p).toContain('They added: go for it')
    expect(p).toContain('DELETE /api/notices/notice-1')
  })

  it('falls back to the raw id when a chosen option has no known label', () => {
    const p = answerPromptText(notice({ answer: { choices: ['opt-unknown'], answeredAt: 2 } }), labels)
    expect(p).toContain('They chose: opt-unknown')
  })

  it('renders a dissent with the objection wording (R13)', () => {
    const p = answerPromptText(notice({ kind: 'fyi', headline: 'Skipped a flaky test', answer: { choices: [], text: 'it caught a real bug', dissent: true, answeredAt: 2 } }), labels)
    expect(p).toContain('The user DISAGREED with your FYI notice "Skipped a flaky test"')
    expect(p).toContain('Their objection: it caught a real bug')
    expect(p).not.toContain('They chose') // no choices on a dissent
  })

  it('returns empty string when the notice has no answer', () => {
    expect(answerPromptText(notice(), labels)).toBe('')
  })
})
