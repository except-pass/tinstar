import { describe, expect, it } from 'vitest'
import { cardReferences } from './references'

const bare = '40d50ce6d422814aa741c102cd00aaae'
const dashed = '40d50ce6-d422-814a-a741-c102cd00aaae'
const other = '30950ce6d42280d3a541cbd66c274f6a'

describe('cardReferences work_item', () => {
  it.each([
    ['bare id', bare],
    ['dashed id', dashed],
    ['notion URL with title slug', `https://www.notion.so/Build-reconciliation-${bare}`],
    ['notion URL with query string', `https://app.notion.com/p/${bare}?pvs=21`],
    ['notion URL with block fragment', `https://notion.so/${bare}#${other}`],
    ['notion URL with query and fragment', `https://notion.so/${bare}?page=${other}#${other}`],
    ['notion URL with fragment before query', `https://notion.so/${bare}#${other}?pvs=21`],
    ['dashed id in a notion URL', `https://notion.so/${dashed}`],
  ])('confirms a %s as an explicit page id', (_label, workItem) => {
    expect(cardReferences({ work_item: workItem }, 'task')).toEqual([
      { pageId: bare, basis: 'explicit', source: 'task.work_item' },
    ])
  })

  it('reads work_item on a backlog row through the same helper', () => {
    expect(cardReferences({ work_item: dashed }, 'task.backlog')).toEqual([
      { pageId: bare, basis: 'explicit', source: 'task.backlog.work_item' },
    ])
  })

  it.each(['task', 'task.backlog', 'backlog'])('uses only URL paths for references on %s', prefix => {
    const url = `https://notion.so/${dashed}#${other}`
    expect(cardReferences({ work_item: url, title: url, raw: url }, prefix)).toEqual([
      { pageId: bare, basis: 'explicit', source: `${prefix}.work_item` },
      { pageId: bare, basis: 'textual', source: `${prefix}.title` },
      { pageId: bare, basis: 'textual', source: `${prefix}.raw` },
    ])
    expect(cardReferences({ work_item: `https://notion.so/workspace#${other}` }, prefix)).toEqual([])
  })

  it.each([
    ['GitHub URL', 'https://github.com/org/repo/issues/1'],
    ['free text', `see card ${bare}`],
    ['notion URL that does not end in a page id', 'https://www.notion.so/workspace'],
    ['null', null],
  ])('adds nothing for a %s', (_label, workItem) => {
    expect(cardReferences({ work_item: workItem }, 'task')).toEqual([])
  })

  it('reads a card id from the brief body without treating the body as an explicit work item', () => {
    expect(cardReferences({
      body_excerpt: `see https://www.notion.so/Build-${bare}`,
      body_lines: [`card ${dashed}`, 'no id here'],
    }, 'task.backlog')).toEqual([
      { pageId: bare, basis: 'textual', source: 'task.backlog.body_excerpt' },
      { pageId: bare, basis: 'textual', source: 'task.backlog.body_lines' },
    ])
    expect(cardReferences({ body_lines: ['no card here', 12] }, 'task.backlog')).toEqual([])
  })

  it('adds nothing when work_item is absent and leaves prior references unchanged', () => {
    const row = {
      title: `Build (card ${bare})`,
      raw: `private text https://app.notion.com/p/${other}`,
      notion_page_id: dashed,
    }
    const before = [
      { pageId: bare, basis: 'explicit', source: 'task.notion_page_id' },
      { pageId: bare, basis: 'textual', source: 'task.title' },
      { pageId: other, basis: 'textual', source: 'task.raw' },
    ]
    expect(cardReferences(row, 'task')).toEqual(before)
    expect(cardReferences({ ...row, work_item: null }, 'task')).toEqual(before)
    expect(cardReferences({ ...row, work_item: 'https://github.com/org/repo' }, 'task')).toEqual(before)
  })
})
