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
  { id: 'helm', state: 'working', project: 'tinstar', direct: false },
  { id: 'keel', state: 'working', project: 'firstmate', direct: false },
  { id: 'spar', state: 'blocked', project: 'tinstar', direct: false },
  { id: 'tiller', state: 'blocked', project: 'stretchplan', direct: false },
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

  it('nests direct and managed work in first-seen order', () => {
    const marked = workers.map(worker => ({ ...worker, direct: worker.id === 'helm' }))
    const groups = groupWorkers(marked, 'direct', 'status')
    expect(groups.map(group => [group.value, ids(group)])).toEqual([
      ['Direct', ['helm']],
      ['Managed', ['keel', 'spar', 'tiller']],
    ])
    expect(groupWorkers(marked, 'status', 'direct')[0]!.groups.map(group => [group.value, ids(group)])).toEqual([
      ['Direct', ['helm']],
      ['Managed', ['keel']],
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
    writeGroupChoice(storage, { primary: 'direct', secondary: 'status' })
    expect(readGroupChoice(storage)).toEqual({ primary: 'direct', secondary: 'status' })
    stored.set(groupChoiceKey, '{"primary":"initiative","secondary":"status"}')
    expect(readGroupChoice(storage)).toEqual(defaultGroupChoice)
    stored.set(groupChoiceKey, '{"primary":"status","secondary":"status"}')
    expect(readGroupChoice(storage)).toEqual(defaultGroupChoice)
    stored.set(groupChoiceKey, 'not-json')
    expect(readGroupChoice(storage)).toEqual(defaultGroupChoice)
    expect(() => writeGroupChoice({ setItem() { throw new Error('private') } }, defaultGroupChoice)).not.toThrow()
  })
})
