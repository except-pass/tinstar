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
    const userHandNames = hands.map(h => h.name).filter(n => n === 'reviewer' || n === 'worker').sort()
    expect(userHandNames).toEqual(['reviewer', 'worker'])
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
    const userHands = hands.filter(h => h.name === 'valid')
    expect(userHands).toHaveLength(1)
    expect(userHands[0]!.name).toBe('valid')
  })

  it('returns only built-ins for non-existent directory', () => {
    const hands = discoverHands('/nonexistent/path')
    // Builtins (e.g. the marshal) are always present even with no user hands dir
    expect(hands.find(h => h.name === 'marshal')).toBeDefined()
  })

  it('includes the built-in marshal hand', () => {
    const hands = discoverHands(testDir)
    const marshal = hands.find(h => h.name === 'marshal')
    expect(marshal).toBeDefined()
    // Marshal uses a dedicated CLI template (claude + sonnet, NATS-enabled);
    // see src/server/hands/builtins/index.ts.
    expect(marshal!.cliTemplate).toBe('Marshal')
  })

  it('lets user-defined hands override built-ins by name', () => {
    writeFileSync(join(testDir, 'marshal.md'), `---
name: marshal
description: my custom marshal
cliTemplate: Custom Template
---

Custom prompt.
`)
    const hands = discoverHands(testDir)
    const marshals = hands.filter(h => h.name === 'marshal')
    expect(marshals).toHaveLength(1)
    expect(marshals[0]!.description).toBe('my custom marshal')
    expect(marshals[0]!.cliTemplate).toBe('Custom Template')
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
