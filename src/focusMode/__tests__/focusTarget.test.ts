import { describe, expect, it } from 'vitest'
import { focusCycleQueue, resolveFocusTarget, runsInFocusSpace } from '../focusTarget'

const run = (
  id: string,
  status: 'working' | 'ready' | 'stopped' = 'working',
  view?: string,
) => ({ id, status, view })

describe('resolveFocusTarget', () => {
  it('distinguishes hydration from settled empty and no-live fleets', () => {
    expect(resolveFocusTarget({ hydrated: false, runs: [], orderedCandidateIds: [] }))
      .toEqual({ kind: 'resolving' })
    expect(resolveFocusTarget({ hydrated: true, runs: [], orderedCandidateIds: [] }))
      .toEqual({ kind: 'empty' })
    expect(resolveFocusTarget({ hydrated: true, runs: [run('stopped', 'stopped')], orderedCandidateIds: ['stopped'] }))
      .toEqual({ kind: 'no-live' })
    expect(resolveFocusTarget({ hydrated: true, runs: [run('custom', 'working', 'roborev-cockpit')], orderedCandidateIds: ['custom'] }))
      .toEqual({ kind: 'no-live' })
  })

  it('prefers a present selected built-in run, then the in-memory target', () => {
    const runs = [run('one'), run('two')]
    expect(resolveFocusTarget({ hydrated: true, runs, selectedRunId: 'two', currentRunId: 'one', orderedCandidateIds: ['one', 'two'] }))
      .toEqual({ kind: 'focused', runId: 'two' })
    expect(resolveFocusTarget({ hydrated: true, runs, selectedRunId: 'missing', currentRunId: 'one', orderedCandidateIds: ['two'] }))
      .toEqual({ kind: 'focused', runId: 'one' })
  })

  it('retains a stopped current target but never chooses a stopped run as a fresh fallback', () => {
    const runs = [run('stopped', 'stopped'), run('live')]
    expect(resolveFocusTarget({ hydrated: true, runs, currentRunId: 'stopped', orderedCandidateIds: ['live'] }))
      .toEqual({ kind: 'focused', runId: 'stopped' })
    expect(resolveFocusTarget({ hydrated: true, runs, orderedCandidateIds: ['stopped', 'live'] }))
      .toEqual({ kind: 'focused', runId: 'live' })
  })

  it('falls back in the supplied session order and skips hidden or custom candidates', () => {
    const runs = [run('hidden'), run('custom', 'working', 'custom-view'), run('visible')]
    expect(resolveFocusTarget({
      hydrated: true,
      runs,
      orderedCandidateIds: ['hidden', 'custom', 'visible'],
      excludedRunIds: new Set(['hidden']),
    })).toEqual({ kind: 'focused', runId: 'visible' })
  })

  it('reconciles an explicitly selected or current run once it becomes hidden', () => {
    const runs = [run('hidden'), run('visible')]
    expect(resolveFocusTarget({
      hydrated: true,
      runs,
      selectedRunId: 'hidden',
      currentRunId: 'hidden',
      orderedCandidateIds: ['hidden', 'visible'],
      excludedRunIds: new Set(['hidden']),
    })).toEqual({ kind: 'focused', runId: 'visible' })
  })

  it('reconciles a removed target without restoring a reusable id', () => {
    const resolution = resolveFocusTarget({
      hydrated: true,
      runs: [run('replacement')],
      currentRunId: 'reused-later',
      orderedCandidateIds: ['replacement'],
    })
    expect(resolution).toEqual({ kind: 'focused', runId: 'replacement' })
    expect(resolution.kind === 'focused' && resolution.runId).not.toBe('reused-later')
  })
})

describe('focusCycleQueue', () => {
  it('preserves visible hierarchy order without dropping collapsed eligible runs', () => {
    expect(focusCycleQueue(
      ['session-one', 'session-two', 'session-three'],
      ['session-three'],
    )).toEqual(['session-three', 'session-one', 'session-two'])
  })

  it('keeps all-run cycling inside the active space while retaining legacy spaceless runs', () => {
    const runs = [
      { id: 'space-a', spaceId: 'a' },
      { id: 'space-b', spaceId: 'b' },
      { id: 'legacy' },
    ]

    expect(runsInFocusSpace(runs, 'a').map(candidate => candidate.id)).toEqual(['space-a', 'legacy'])
  })
})
