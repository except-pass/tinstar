// U3 (R2/R5/R12): a run node's sidebar label is its friendly name when it has
// one, and its id otherwise. `label: run.id` used to be hardcoded in THREE
// separate tree-build paths in buildGroupTree — the leaf path, the non-root
// orphan path, and the root orphan path — so each is exercised here. A run that
// only appears in one of them must not be the run that still shows a raw id.
//
// The name-vs-id rule itself (`||`, never `??`) lives in runDisplayName and is
// tested in runName.test.ts; these tests pin that every tree path goes through it.
import { describe, it, expect } from 'vitest'
import { buildGroupTree } from '../grouping'
import { TaxonomyRepository } from '../repositories'
import type { Run } from '../types'

/** Empty taxonomy: every resolveDimension() returns undefined, so any run fed
 *  through a dimension lands on an orphan path. */
const emptyTaxonomy = () => new TaxonomyRepository([], [], [], [])

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    status: 'idle',
    background: false,
    blocked: false,
    sessionId: id,
    taskId: 'tsk-missing',
    worktreeId: 'wt-missing',
    createdAt: '2026-07-13T00:00:00.000Z',
    initiative: '',
    epic: '',
    task: '',
    repo: '',
    worktree: '',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: 'tmux',
    ...overrides,
  } as Run
}

describe('buildGroupTree run labels — leaf path (no dimensions left)', () => {
  it('labels an unnamed run with its id', () => {
    const nodes = buildGroupTree([run('run-a')], [], emptyTaxonomy())
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.label).toBe('run-a')
    expect(nodes[0]?.entityId).toBe('run-a')
  })

  it('labels a named run with its name, leaving id/entityId untouched', () => {
    const nodes = buildGroupTree([run('run-a', { name: 'PM Vpp project' })], [], emptyTaxonomy())
    expect(nodes[0]?.label).toBe('PM Vpp project')
    // The id is the identity — the rename must never touch it.
    expect(nodes[0]?.id).toBe('run-run-a')
    expect(nodes[0]?.entityId).toBe('run-a')
  })

  it('falls back to the id when the name is an empty string', () => {
    const nodes = buildGroupTree([run('run-a', { name: '' })], [], emptyTaxonomy())
    expect(nodes[0]?.label).toBe('run-a')
  })
})

describe('buildGroupTree run labels — non-root orphan path', () => {
  // A run inside a group whose value for this dimension can't be resolved
  // (e.g. no worktree) is emitted as a run node directly at the leaf level.
  it('labels orphan runs by name, falling back to the id', () => {
    const nodes = buildGroupTree(
      [run('run-named', { name: 'Reviewer — dispatch retry' }), run('run-plain')],
      ['task'],
      emptyTaxonomy(),
      false,
    )
    const labels = nodes.map(n => n.label)
    expect(labels).toContain('Reviewer — dispatch retry')
    expect(labels).toContain('run-plain')
  })

  it('falls back to the id when an orphan run has an empty-string name', () => {
    const nodes = buildGroupTree([run('run-plain', { name: '' })], ['task'], emptyTaxonomy(), false)
    expect(nodes[0]?.label).toBe('run-plain')
  })
})

describe('buildGroupTree run labels — root orphan path', () => {
  it('labels root-level orphan runs by name, falling back to the id', () => {
    const nodes = buildGroupTree(
      [run('run-named', { name: 'PM Vpp project' }), run('run-plain')],
      ['task'],
      emptyTaxonomy(),
      true,
    )
    const orphans = nodes.filter(n => n.orphan && n.type === 'run')
    expect(orphans).toHaveLength(2)
    expect(orphans.map(n => n.label).sort()).toEqual(['PM Vpp project', 'run-plain'])
  })

  it('falls back to the id when a root orphan run has an empty-string name', () => {
    const nodes = buildGroupTree([run('run-plain', { name: '' })], ['task'], emptyTaxonomy(), true)
    const orphan = nodes.find(n => n.type === 'run')
    expect(orphan?.label).toBe('run-plain')
  })
})
