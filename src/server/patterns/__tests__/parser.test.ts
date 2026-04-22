import { describe, it, expect } from 'vitest'
import { parsePatternFile } from '../parser'

describe('parsePatternFile', () => {
  it('parses pattern with orchestrator and worker sessions', () => {
    const content = `---
name: bug-review
description: Worker searches, orchestrator reviews
---

orchestrator:
  backend: tmux
  project: myproject
  prompt: |
    You are orchestrating a bug review for {{task}}.

worker:
  backend: tmux
  project: myproject
  worktree: true
  prompt: |
    You are a worker on {{task}}.
`

    const result = parsePatternFile(content)

    expect(result).not.toBeNull()
    expect(result!.name).toBe('bug-review')
    expect(result!.description).toBe('Worker searches, orchestrator reviews')
    expect(result!.sessions).toHaveLength(2)
    expect(result!.sessions[0]!.role).toBe('orchestrator')
    expect(result!.sessions[0]!.config.backend).toBe('tmux')
    expect(result!.sessions[0]!.config.prompt).toContain('{{task}}')
    expect(result!.sessions[1]!.role).toBe('worker')
    expect(result!.sessions[1]!.config.worktree).toBe(true)
  })

  it('returns null for invalid pattern', () => {
    const result = parsePatternFile('not valid yaml')
    expect(result).toBeNull()
  })
})

describe('parsePatternFile with hands', () => {
  it('parses pattern with hand references', () => {
    const content = `---
name: review-critique
description: Code review pattern
orchestrator: reviewer
---

worker:
  hand: general-purpose
  prompt: |
    You do the implementation work.

reviewer:
  hand: reviewer
  dependsOn:
    worker:
      condition: ready
`
    const pattern = parsePatternFile(content)
    expect(pattern).not.toBeNull()
    expect(pattern!.name).toBe('review-critique')
    expect(pattern!.orchestrator).toBe('reviewer')
    expect(pattern!.sessions).toHaveLength(2)

    const worker = pattern!.sessions.find(s => s.role === 'worker')
    expect(worker?.config.hand).toBe('general-purpose')

    const reviewer = pattern!.sessions.find(s => s.role === 'reviewer')
    expect(reviewer?.config.hand).toBe('reviewer')
  })

  it('allows inline prompts for backward compatibility', () => {
    const content = `---
name: simple
description: Simple pattern
---

worker:
  prompt: |
    You are a worker. Do the work.
`
    const pattern = parsePatternFile(content)
    expect(pattern).not.toBeNull()
    expect(pattern!.sessions[0]?.config.prompt).toContain('You are a worker')
    expect(pattern!.sessions[0]?.config.hand).toBeUndefined()
  })
})
