import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverHands, getHandByName } from '../discovery'

describe('discoverHands', () => {
  const testDir = join(tmpdir(), `tinstar-hands-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('discovers hand files from directory', () => {
    writeFileSync(join(testDir, 'reviewer.md'), `---
name: reviewer
description: Code reviewer
---

Review code.
`)
    writeFileSync(join(testDir, 'worker.md'), `---
name: worker
description: General worker
---

Do work.
`)

    const hands = discoverHands(testDir)
    expect(hands).toHaveLength(2)
    expect(hands.map(h => h.name).sort()).toEqual(['reviewer', 'worker'])
  })

  it('skips invalid files', () => {
    writeFileSync(join(testDir, 'valid.md'), `---
name: valid
description: Valid hand
---

Prompt.
`)
    writeFileSync(join(testDir, 'invalid.md'), `No frontmatter`)
    writeFileSync(join(testDir, 'readme.txt'), `Not a markdown file`)

    const hands = discoverHands(testDir)
    expect(hands).toHaveLength(1)
    expect(hands[0]!.name).toBe('valid')
  })

  it('returns empty array for non-existent directory', () => {
    const hands = discoverHands('/nonexistent/path')
    expect(hands).toEqual([])
  })
})

describe('getHandByName', () => {
  const testDir = join(tmpdir(), `tinstar-hands-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, 'reviewer.md'), `---
name: reviewer
description: Code reviewer
---

Review code.
`)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns hand by name', () => {
    const hand = getHandByName('reviewer', testDir)
    expect(hand).not.toBeNull()
    expect(hand!.name).toBe('reviewer')
  })

  it('returns null for unknown hand', () => {
    const hand = getHandByName('unknown', testDir)
    expect(hand).toBeNull()
  })
})
