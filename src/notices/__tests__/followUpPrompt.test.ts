import { describe, it, expect } from 'vitest'
import type { Notice } from '../../domain/types'
import type { Reply } from '../../domain/pinSet'
import { followUpPromptText, followUpThreadSoFar, isThreadWindowed, PROMPT_THREAD_WINDOW } from '../followUpPrompt'
import { UNIVERSAL_FOLLOW_UPS } from '../../plugins/roundup/src/a2ui/followUps'

const ORIGIN = 'http://localhost:5273'

function notice(followUps: Reply[]): Notice {
  return {
    id: 'notice-1',
    runId: 'CLD-run-1',
    kind: 'needs-you',
    headline: 'Rollback or roll forward?',
    createdAt: 1_700_000_000_000,
    amendedAt: 1_700_000_000_000,
    followUps,
  }
}

const question: Reply = { id: 'fu-1', author: 'user', text: 'Can you explain that more plainly?', createdAt: 1 }

describe('followUpThreadSoFar', () => {
  it('renders one line per message, oldest first, tagged by author', () => {
    expect(followUpThreadSoFar([
      { id: 'a', author: 'user', text: 'why?', createdAt: 1 },
      { id: 'b', author: 'agent', text: 'because CI', createdAt: 2 },
    ])).toBe('[user] why?\n[agent] because CI')
  })

  it('is empty for an empty thread', () => {
    expect(followUpThreadSoFar([])).toBe('')
  })
})

describe('followUpPromptText', () => {
  it('names the notice and quotes the question that was just asked', () => {
    const out = followUpPromptText(notice([question]), undefined, ORIGIN)
    expect(out).toContain('Rollback or roll forward?')
    expect(out).toContain('notice-1')
    expect(out).toContain('Can you explain that more plainly?')
  })

  // The both-and contract. Reply-only is the failure mode: the thread ends up
  // holding the real explanation while the card everyone glances at stays wrong.
  it('instructs BOTH a thread reply AND an amend, with the exact endpoints baked in', () => {
    const out = followUpPromptText(notice([question]), undefined, ORIGIN)
    expect(out).toContain('Do BOTH of these')
    // (i) reply on the thread
    expect(out).toContain(`POST '${ORIGIN}/api/notices/notice-1/replies'`)
    expect(out).toContain('"author":"agent"')
    // (ii) amend the notice
    expect(out).toContain(`PATCH '${ORIGIN}/api/notices/notice-1'`)
    expect(out).toMatch(/AMEND the notice/)
  })

  it("carries the preset's agent-only guidance, which never appears in the thread itself", () => {
    const simplify = UNIVERSAL_FOLLOW_UPS.find(p => p.id === 'simplify')!
    const out = followUpPromptText(notice([question]), simplify.guidance, ORIGIN)
    expect(out).toContain(simplify.guidance!)
    // The de-nerd requirement survives into the delivered prompt.
    expect(out).toMatch(/precision/i)
    // The thread message stays the short human question, not the guidance blob.
    expect(question.text).not.toContain('precision')
  })

  it('omits the guidance section entirely for a freeform question', () => {
    const out = followUpPromptText(notice([question]), undefined, ORIGIN)
    expect(out).not.toContain('What they are asking for:')
  })

  it('includes the thread so far only once there is prior context', () => {
    const single = followUpPromptText(notice([question]), undefined, ORIGIN)
    expect(single).not.toContain('The thread so far:')

    const multi = followUpPromptText(notice([
      question,
      { id: 'fu-2', author: 'agent', text: 'here you go', createdAt: 2 },
      { id: 'fu-3', author: 'user', text: 'and the rollback cost?', createdAt: 3 },
    ]), undefined, ORIGIN)
    expect(multi).toContain('The thread so far:')
    expect(multi).toContain('[agent] here you go')
    // The question quoted at the top is the LAST message, not the first.
    expect(multi).toContain('Their question: and the rollback cost?')
  })

  // Without a window, every delivered prompt re-serializes the ENTIRE history, so a
  // long-lived chatty notice grows the agent's context without bound.
  it(`windows the thread to the last ${PROMPT_THREAD_WINDOW} messages and says so`, () => {
    const long: Reply[] = Array.from({ length: PROMPT_THREAD_WINDOW + 15 }, (_, i) => ({
      id: `fu-${i}`,
      author: i % 2 === 0 ? 'agent' as const : 'user' as const,
      text: `message-${i}`,
      createdAt: i,
    }))
    const out = followUpPromptText(notice(long), undefined, ORIGIN)

    // The oldest messages are dropped, the newest are kept.
    expect(out).not.toContain('message-0')
    expect(out).not.toContain('message-14')
    expect(out).toContain(`message-${long.length - 1}`)
    // Exactly the window's worth of thread lines.
    expect(followUpThreadSoFar(long).split('\n')).toHaveLength(PROMPT_THREAD_WINDOW)
    // And the agent is TOLD it's a window, so it doesn't silently contradict
    // something it said earlier in a history it can no longer see.
    expect(out).toContain(`the last ${PROMPT_THREAD_WINDOW} of ${long.length} messages`)
    expect(out).toContain('GET /api/notices')
  })

  it('does not announce a window when the thread fits', () => {
    const out = followUpPromptText(notice([
      question,
      { id: 'fu-2', author: 'agent', text: 'here you go', createdAt: 2 },
    ]), undefined, ORIGIN)
    expect(out).toContain('The thread so far:')
    expect(out).not.toContain('read the full thread')
  })

  it('isThreadWindowed flips exactly at the window boundary', () => {
    const make = (n: number): Reply[] => Array.from({ length: n }, (_, i) => ({
      id: `x${i}`, author: 'user' as const, text: 't', createdAt: i,
    }))
    expect(isThreadWindowed(make(PROMPT_THREAD_WINDOW))).toBe(false)
    expect(isThreadWindowed(make(PROMPT_THREAD_WINDOW + 1))).toBe(true)
  })

  it('does not throw on a notice with no thread yet', () => {
    const bare = { ...notice([]), followUps: undefined }
    expect(() => followUpPromptText(bare, undefined, ORIGIN)).not.toThrow()
  })
})
