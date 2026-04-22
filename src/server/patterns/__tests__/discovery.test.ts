import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverPatterns } from '../discovery'

describe('discoverPatterns', () => {
  const testDir = join(tmpdir(), 'tinstar-patterns-test-' + Date.now())

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('discovers pattern files in directory', () => {
    writeFileSync(join(testDir, 'bug-review.md'), `---
name: bug-review
description: Bug review pattern
---

orchestrator:
  backend: tmux
  prompt: Test

worker:
  backend: tmux
  prompt: Test
`)

    const patterns = discoverPatterns(testDir)

    expect(patterns).toHaveLength(1)
    expect(patterns[0]!.name).toBe('bug-review')
    expect(patterns[0]!.sessions).toHaveLength(2)
  })

  it('returns empty array for non-existent directory', () => {
    const patterns = discoverPatterns('/nonexistent/path')
    expect(patterns).toEqual([])
  })

  it('skips invalid pattern files', () => {
    writeFileSync(join(testDir, 'valid.md'), `---
name: valid
description: Valid pattern
---

orchestrator:
  backend: tmux
  prompt: Test
`)
    writeFileSync(join(testDir, 'invalid.md'), 'not a valid pattern')

    const patterns = discoverPatterns(testDir)

    expect(patterns).toHaveLength(1)
    expect(patterns[0]!.name).toBe('valid')
  })
})
