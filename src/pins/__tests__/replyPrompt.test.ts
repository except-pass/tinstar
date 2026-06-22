import { describe, it, expect } from 'vitest'
import { replyInstructions, threadSoFar } from '../replyPrompt'
import type { Pin } from '../../domain/pinSet'

describe('replyInstructions', () => {
  it('bakes the spaceId-less curl with the note id and origin', () => {
    const out = replyInstructions('pin-7', 'http://localhost:5273')
    expect(out).toContain('http://localhost:5273/api/notes/pin-7/replies')
    expect(out).toContain('curl')
    expect(out).toContain('"text"')
  })
})

describe('threadSoFar', () => {
  it('renders the comment then replies with author tags', () => {
    const pin: Pin = {
      id: 'pin-7', nodeId: 'n', nx: 0, ny: 0, comment: 'why?', createdAt: 1,
      replies: [{ id: 'r1', author: 'agent', text: 'because', createdAt: 2 }, { id: 'r2', author: 'user', text: 'still unclear', createdAt: 3 }],
    }
    expect(threadSoFar(pin)).toBe('[user] why?\n[agent] because\n[user] still unclear')
  })
})
