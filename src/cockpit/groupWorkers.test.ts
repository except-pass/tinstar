import { describe, expect, it } from 'vitest'
import {
  applyGroupChoice,
  defaultGroupChoice,
  groupChoiceKey,
  groupWorkers,
  readGroupChoice,
  writeGroupChoice,
  type GroupableWorker,
} from './groupWorkers'

const workers: Array<GroupableWorker & { id: string }> = [
  { id: 'helm', state: 'working', project: 'tinstar' },
  { id: 'keel', state: 'working', project: 'firstmate' },
  { id: 'spar', state: 'blocked', project: 'tinstar' },
  { id: 'tiller', state: 'blocked', project: 'stretchplan' },
]

const ids = (group: { workers: Array<{ id: string }> }) => group.workers.map(worker => worker.id)

describe('worker overview grouping', () => {
  it('nests project under status in first-seen order', () => {
    const groups = groupWorkers(workers, 'status', 'project')
    expect(groups.map(group => group.value)).toEqual(['working', 'blocked'])
    expect(ids(groups[0]!)).toEqual(['helm', 'keel'])
    expect(groups[0]!.groups.map(group => [group.value, ids(group)])).toEqual([
      ['tinstar', ['helm']],
      ['firstmate', ['keel']],
    ])
    expect(groups[1]!.groups.map(group => group.value)).toEqual(['tinstar', 'stretchplan'])
  })

  it('nests status under project', () => {
    const groups = groupWorkers(workers, 'project', 'status')
    expect(groups.map(group => group.value)).toEqual(['tinstar', 'firstmate', 'stretchplan'])
    expect(groups[0]!.groups.map(group => [group.value, ids(group)])).toEqual([
      ['working', ['helm']],
      ['blocked', ['spar']],
    ])
  })

  it('keeps one level when both choices are the same dimension', () => {
    const groups = groupWorkers(workers, 'status', 'status')
    expect(groups.map(group => [group.value, ids(group), group.groups])).toEqual([
      ['working', ['helm', 'keel'], []],
      ['blocked', ['spar', 'tiller'], []],
    ])
  })

  it('swaps the other level when a choice would repeat', () => {
    expect(applyGroupChoice({ primary: 'status', secondary: 'project' }, 'primary', 'project')).toEqual({
      primary: 'project', secondary: 'status',
    })
    expect(applyGroupChoice({ primary: 'project', secondary: 'status' }, 'secondary', 'project')).toEqual({
      primary: 'status', secondary: 'project',
    })
  })

  it('remembers a valid choice and ignores a broken one', () => {
    const stored = new Map<string, string>()
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    }
    expect(readGroupChoice(null)).toEqual(defaultGroupChoice)
    expect(readGroupChoice(storage)).toEqual(defaultGroupChoice)
    writeGroupChoice(storage, { primary: 'project', secondary: 'status' })
    expect(stored.get(groupChoiceKey)).toBe('{"primary":"project","secondary":"status"}')
    expect(readGroupChoice(storage)).toEqual({ primary: 'project', secondary: 'status' })
    stored.set(groupChoiceKey, '{"primary":"status","secondary":"status"}')
    expect(readGroupChoice(storage)).toEqual(defaultGroupChoice)
    stored.set(groupChoiceKey, 'not-json')
    expect(readGroupChoice(storage)).toEqual(defaultGroupChoice)
    expect(() => writeGroupChoice({ setItem() { throw new Error('private') } }, defaultGroupChoice)).not.toThrow()
  })
})
