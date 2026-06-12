import { describe, it, expect } from 'vitest'
import { migrateBrowserNotesToPins } from '../migrateBrowserNotesToPins'

describe('migrateBrowserNotesToPins', () => {
  it('maps a BrowserNote to a Pin carrying url+docX/docY+target in context', () => {
    const note = { id: 'note-1', url: 'http://x/', comment: 'hi', x: 10, y: 20, nx: 0.1, ny: 0.2, target: { tag: 'h2' }, createdAt: 5, sentAt: 6 }
    const pins = migrateBrowserNotesToPins('browser-w1', [note as any])
    expect(pins).toEqual([{
      id: 'note-1', nodeId: 'browser-w1', nx: 0.1, ny: 0.2, comment: 'hi',
      createdAt: 5, sentAt: 6, context: { url: 'http://x/', docX: 10, docY: 20, target: { tag: 'h2' } },
    }])
  })
  it('omits sentAt when the note was never sent, and target when absent', () => {
    const note = { id: 'n2', url: 'http://y/', comment: '', x: 1, y: 2, nx: 0, ny: 0, createdAt: 9 }
    const pins = migrateBrowserNotesToPins('browser-w1', [note as any])
    expect(pins[0]).toEqual({ id: 'n2', nodeId: 'browser-w1', nx: 0, ny: 0, comment: '', createdAt: 9, context: { url: 'http://y/', docX: 1, docY: 2 } })
    expect('sentAt' in pins[0]!).toBe(false)
  })
  it('returns [] for a widget with no notes', () => {
    expect(migrateBrowserNotesToPins('browser-w1', undefined)).toEqual([])
    expect(migrateBrowserNotesToPins('browser-w1', [])).toEqual([])
  })
})
