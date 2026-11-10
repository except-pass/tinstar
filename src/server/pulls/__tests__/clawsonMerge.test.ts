import { expect, it, vi } from 'vitest'
import { prepareClawsonMerge } from '../clawsonMerge'

const head = 'a'.repeat(40), other = 'b'.repeat(40)
const input = { operation_id: 'a9597ba8-77f5-4c14-9e56-dac9103fc578', targets: [1, 2].map(number => ({ url: `https://github.com/owner/repo/pull/${number}`, head: number === 1 ? head : other })) }
function fixture(problem = '') {
  let reads = 0
  return vi.fn(async (path: string): Promise<unknown> => {
    const sha = path.includes('/pulls/2') || path.includes(other) ? other : head
    if (/\/pulls\/\d+$/.test(path)) { reads++; return { head: { sha: problem === 'changed' && reads > 1 ? other : sha }, base: { ref: 'main' }, state: problem === 'closed' ? 'closed' : 'open', merged: problem === 'merged', draft: problem === 'draft', mergeable: problem === 'conflict' ? false : problem === 'unknown' ? null : true } }
    if (path.includes('/rules/')) return [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: problem === 'missing' ? 'absent' : 'CI', integration_id: problem === 'app' ? 999 : 1 }] } }]
    if (path.includes('/branches/')) return { protection: { required_status_checks: { contexts: ['CI'] } } }
    if (path.includes('/check-runs')) return { total_count: problem === 'partial' ? 2 : 1, check_runs: [{ name: 'CI', head_sha: problem === 'wrong-check-head' ? other : sha, status: problem === 'pending' ? 'in_progress' : 'completed', conclusion: problem === 'red' ? 'failure' : 'success', app: { id: 1 } }] }
    if (path.includes('/status?')) return { total_count: 0, sha, statuses: [] }
    throw new Error('Unexpected read')
  })
}
it('captures two exact heads and bounded merge words, commands, prechecks and per-PR returns', async () => {
  const read = fixture(), result = await prepareClawsonMerge(input, 'owner@example.test', read, () => Date.parse('2026-11-10T12:00:00Z'))
  expect(result).toMatchObject({ at: '2026-11-10T12:00:00.000Z', name: 'Admin merge 2 PRs: owner/repo' })
  for (const target of input.targets) expect(result.brief).toContain(`gh pr merge ${target.url} --squash --admin --match-head-commit ${target.head}`)
  expect(result.brief).toContain('owner@example.test gave the Merge action')
  expect(result.brief).toContain('Nothing else is authorized')
  expect(result.brief).toContain('Before EACH merge')
  expect(result.brief).toContain('the head has changed, or there is a conflict')
  expect(result.brief).toContain('Post one comment per PR on this card')
  expect(read.mock.calls.every(([path]) => path.startsWith('/repos/owner/repo/'))).toBe(true)
})
it.each([['red', 'CI is failure'], ['pending', 'CI is pending'], ['draft', 'still a draft'], ['merged', 'already merged'], ['closed', 'closed'], ['conflict', 'has merge conflicts'], ['unknown', 'not confirmed'], ['changed', 'changed'], ['missing', 'required check absent'], ['app', 'required check CI'], ['partial', 'incomplete'], ['wrong-check-head', 'do not match']])('refuses %s before preparing any card', async (problem, reason) => {
  await expect(prepareClawsonMerge(input, 'owner', fixture(problem))).rejects.toThrow(reason)
})
