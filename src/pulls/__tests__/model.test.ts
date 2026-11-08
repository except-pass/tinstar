import { expect, it } from 'vitest'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { pullContext } from '../model'
import { registeredPulls } from '../../shared/releases'
import type { PullSummary } from '../../shared/pulls'
const pull = { id: 'owner/repo#1', repository: 'owner/repo', number: 1, url: 'https://github.com/owner/repo/pull/1', head: 'a'.repeat(40), links: [] } as unknown as PullSummary
it('shows multiple exact contributors and retained retired registration without inventing identity fields', () => {
  const scene = fixtureScene()
  const [one, two] = scene.executions
  one!.source.pr = { url: pull.url, head: pull.head, source: 'task metadata' }
  two!.source.pr = { url: pull.url, head: 'b'.repeat(40), source: 'task metadata' }
  two!.liveness = 'finished'
  scene.backlog.push({ id: 'retained', home: '/retired/home', source: { ...scene.backlog[0]!.source, id: 'retired-task', state: 'done', pr_url: pull.url }, observation: one!.observation })
  const context = pullContext(scene, pull)
  expect(context.contributors).toHaveLength(3)
  expect(context.contributors[0]).toMatchObject({ state: 'Confirmed', task: one!.identity.task_id, registeredHead: pull.head })
  expect(context.contributors[1]).toMatchObject({ state: 'Historical', task: two!.identity.task_id, registeredHead: 'b'.repeat(40) })
  expect(context.contributors[2]).toMatchObject({ state: 'Historical', task: 'retired-task', home: '/retired/home', attempt: null, machine: null, manager: '', registeredHead: null })
  expect(registeredPulls(scene).map(pull => pull.id)).toContain(pull.id)
  expect(pullContext(scene, { ...pull, id: 'other/repo#1' }).contributors).toEqual([])
  one!.observation.status = 'stale'
  expect(pullContext(scene, pull).contributors[0]?.state).toBe('Last known')
})
