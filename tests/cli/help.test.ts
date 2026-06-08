import { describe, it, expect } from 'vitest'
import { buildIndex } from '../../bin/tinstar/help.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// help.js is plain JS; describe the index shape it returns for type-checking.
interface HelpEntry { title: string; description: string }
const index = (dir: string) => buildIndex(dir) as Record<string, HelpEntry>

describe('tinstar help index', () => {
  it('indexes markdown files with title front-matter', () => {
    const idx = index(path.join(__dirname, '../fixtures/help'))
    expect(idx.epics).toBeDefined()
    expect(idx.epics!.title).toBe('Epics')
    expect(idx.epics!.description).toMatch(/group tasks/i)
  })

  it('skips files without title front-matter', () => {
    const idx = index(path.join(__dirname, '../fixtures/help'))
    expect(idx['no-frontmatter']).toBeUndefined()
  })
})
