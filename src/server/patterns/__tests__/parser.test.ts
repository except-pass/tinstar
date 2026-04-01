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
    expect(result!.sessions[0].role).toBe('orchestrator')
    expect(result!.sessions[0].config.backend).toBe('tmux')
    expect(result!.sessions[0].config.prompt).toContain('{{task}}')
    expect(result!.sessions[1].role).toBe('worker')
    expect(result!.sessions[1].config.worktree).toBe(true)
  })

  it('returns null for invalid pattern', () => {
    const result = parsePatternFile('not valid yaml')
    expect(result).toBeNull()
  })
})
