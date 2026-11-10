import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  for (const target of input.targets) expect(result.script).toContain(`gh pr merge ${target.url} --squash --admin --match-head-commit ${target.head}`)
  expect(result.brief).toContain('owner@example.test gave the Merge action')
  expect(result.brief).toContain('Nothing else is authorized')
  expect(result.script).toContain('set -euo pipefail')
  expect(read.mock.calls.every(([path]) => path.startsWith('/repos/owner/repo/'))).toBe(true)
})
it.each([['red', 'CI is failure'], ['pending', 'CI is pending'], ['draft', 'still a draft'], ['merged', 'already merged'], ['closed', 'closed'], ['conflict', 'has merge conflicts'], ['unknown', 'not confirmed'], ['changed', 'changed'], ['missing', 'required check absent'], ['app', 'required check CI'], ['partial', 'incomplete'], ['wrong-check-head', 'do not match']])('refuses %s before preparing any card', async (problem, reason) => {
  await expect(prepareClawsonMerge(input, 'owner', fixture(problem))).rejects.toThrow(reason)
})

const scriptRoots: string[] = []
afterEach(async () => { await Promise.all(scriptRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function executeCardScript(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'clawson-script-')); scriptRoots.push(root)
  const log = join(root, 'calls')
  await writeFile(join(root, 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_TEST_LOG"
sha=${head}
[[ "$3" == */pull/2 ]] && sha=${other}
case "$2" in
  view)
    case "$5" in
      headRefOid) [[ "$GH_TEST_CASE" == moved && "$3" == */pull/1 ]] && sha=${other}; printf '%s\\n' "$sha" ;;
      mergeable) if [[ "$GH_TEST_CASE" == conflict && "$3" == */pull/1 ]]; then printf 'CONFLICTING\\n'; else printf 'MERGEABLE\\n'; fi ;;
      state,mergeCommit) printf 'MERGED %s\\n' "$sha" ;;
      *) exit 2 ;;
    esac ;;
  checks)
    if [[ "$GH_TEST_CASE" == unavailable ]]; then exit 1; fi
    if [[ "$3" == */pull/1 && ( "$GH_TEST_CASE" == fail || "$GH_TEST_CASE" == pending ) || "$3" == */pull/2 && "$GH_TEST_CASE" == second-pending ]]; then
      printf '1\\n'; exit 8
    fi
    printf '0\\n' ;;
  merge) [[ "$GH_TEST_CASE" != merge-failed ]] ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 })
  const plan = await prepareClawsonMerge(input, 'owner@example.test', fixture())
  const result = spawnSync('/bin/bash', ['-s'], { input: plan.script, encoding: 'utf8', env: { ...process.env, PATH: root, GH_TEST_LOG: log, GH_TEST_CASE: scenario } })
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  return { result, calls, merges: calls.filter(call => call.startsWith('pr merge ')) }
}
it('runs the emitted card script against a disposable gh and prints both merge results', async () => {
  const { result, merges } = await executeCardScript('green')
  expect(result.status).toBe(0)
  expect(merges).toEqual(input.targets.map(target => `pr merge ${target.url} --squash --admin --match-head-commit ${target.head}`))
  expect(result.stdout.trim().split('\n')).toEqual([`MERGED ${head}`, `MERGED ${other}`])
})
it.each(['moved', 'conflict', 'fail', 'pending', 'unavailable'])('stops the emitted script before merging when the first PR is %s', async scenario => {
  const { result, merges } = await executeCardScript(scenario)
  expect(result.status).not.toBe(0)
  expect(merges).toEqual([])
})
it('stops the batch on a pending second PR and retains the first merge result', async () => {
  const { result, merges } = await executeCardScript('second-pending')
  expect(result.status).not.toBe(0)
  expect(merges).toEqual([`pr merge ${input.targets[0]!.url} --squash --admin --match-head-commit ${head}`])
  expect(result.stdout.trim()).toBe(`MERGED ${head}`)
})
it('stops after a failed merge command without attempting the next PR', async () => {
  const { result, merges } = await executeCardScript('merge-failed')
  expect(result.status).not.toBe(0)
  expect(merges).toHaveLength(1)
  expect(result.stdout).toBe('')
})
