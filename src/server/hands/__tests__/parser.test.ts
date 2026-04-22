import { describe, it, expect } from 'vitest'
import { parseHandFile } from '../parser'

describe('parseHandFile', () => {
  it('parses a valid hand definition', () => {
    const content = `---
name: reviewer
description: Reviews code for quality and security
cliTemplate: Claude (multi-agent)
---

You are a code reviewer. Focus on edge cases and security.

<agent-protocol>
When you spawn, announce yourself on the task channel.
</agent-protocol>
`
    const hand = parseHandFile(content)
    expect(hand).not.toBeNull()
    expect(hand!.name).toBe('reviewer')
    expect(hand!.description).toBe('Reviews code for quality and security')
    expect(hand!.cliTemplate).toBe('Claude (multi-agent)')
    expect(hand!.prompt).toContain('You are a code reviewer')
    expect(hand!.prompt).toContain('<agent-protocol>')
  })

  it('returns null for invalid frontmatter', () => {
    const content = `No frontmatter here`
    expect(parseHandFile(content)).toBeNull()
  })

  it('returns null when name is missing', () => {
    const content = `---
description: Missing name field
---

Some prompt text.
`
    expect(parseHandFile(content)).toBeNull()
  })

  it('defaults cliTemplate to Claude (multi-agent)', () => {
    const content = `---
name: worker
description: General purpose worker
---

Do work.
`
    const hand = parseHandFile(content)
    expect(hand!.cliTemplate).toBe('Claude (multi-agent)')
  })
})
