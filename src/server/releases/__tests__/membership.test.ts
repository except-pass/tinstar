import { describe, expect, it, vi } from 'vitest'
import { ReleaseMembershipReader } from '../membership'
const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40)
const tag = (name: string, sha: string) => ({ name, commit: { sha } })
const pull = (number: number, mergeSha = merge) => ({ number, title: `Actual change ${number}`, html_url: `https://github.com/owner/repo/pull/${number}`, merged_at: '2026-11-10T12:00:00Z', merge_commit_sha: mergeSha, head: { sha: head }, base: { ref: 'main' } })
describe('Git release membership', () => {
  it('requires a proven previous-source range and effective merge identity, deduplicating repeated PR associations', async () => {
    const read = vi.fn(async (path: string) => path.includes('/tags?') ? [tag('v2.0.0', head), tag('v1.0.0', base)] : path.includes('/compare/') ? { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 2, commits: [{ sha: merge }, { sha: head }] } : [pull(1), pull(2, 'd'.repeat(40))])
    const reader = new ReleaseMembershipReader(read)
    const range = await reader.get('owner/repo', head, 'v2.0.0')
    expect(range.membership).toMatchObject({ status: 'complete', baseline: 'v1.0.0', baselineSha: base })
    expect([...range.pulls.values()].map(pull => pull.number)).toEqual([1])
    await reader.get('owner/repo', head, 'v2.0.0')
    expect(read).toHaveBeenCalledTimes(4)
  })
  it.each([false, true])('ignores non-production baseline tags with supplied catalog: %s', async supplied => {
    const tags = [tag('v1.24.0', base), ...['v1.25.0-rc1', 'v1.25.0+build', 'v1.25.0.1', '1.25.0'].map(name => tag(name, merge))]
    const read = vi.fn(async (path: string) => path.includes('/tags?') ? tags : { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 0, commits: [] })
    const range = await new ReleaseMembershipReader(read).get('owner/repo', head, 'v1.26.0', supplied ? tags : undefined)
    expect(range.membership).toMatchObject({ status: 'complete', baseline: 'v1.24.0', baselineSha: base })
  })
  it.each(['v1.25.0-rc1', 'v1.25.0+build', 'v1.25.0.1', '1.25.0'])('does not compute membership for non-production tag %s', async name => {
    const read = vi.fn()
    const range = await new ReleaseMembershipReader(read).get('owner/repo', head, name, [tag('v1.24.0', base)])
    expect(range.membership).toMatchObject({ status: 'unknown', baseline: null })
    expect(read).not.toHaveBeenCalled()
  })
  it('retains partial progress through failure and replaces superseded PRs on their next turn', async () => {
    let now = 0
    let pullNumber = 1
    const commits = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(40, '0'))
    const read = vi.fn(async (path: string) => path.includes('/tags?') ? [tag('v1.0.0', base)] : path.includes('/compare/') ? { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 10, commits: commits.map(sha => ({ sha })) } : path.includes(commits[0]!) ? [pull(pullNumber, commits[0]!)] : [])
    const reader = new ReleaseMembershipReader(read, () => now)
    const first = await reader.get('owner/repo', head, 'v2.0.0')
    expect(first.membership.status).toBe('partial'); expect(first.cursor).toBe(8)
    now = 20_000; read.mockRejectedValueOnce(new Error('Read unavailable'))
    const failed = await reader.get('owner/repo', head, 'v2.0.0')
    expect(failed.membership.status).toBe('partial'); expect(failed.pulls.size).toBe(1)
    pullNumber = 2
    now = 90_000
    const rotated = await reader.get('owner/repo', head, 'v2.0.0')
    expect(rotated.membership.status).toBe('partial')
    expect([...rotated.pulls.values()].map(row => row.number)).toEqual([2])
    expect(read.mock.calls.filter(([path]) => path.includes('/commits/'))).toHaveLength(18)

    now = 110_000
    const resumed = await reader.get('owner/repo', head, 'v2.0.0')
    expect(resumed.membership.status).toBe('complete')
    expect([...resumed.pulls.values()].map(row => row.number)).toEqual([2])
    expect(read.mock.calls.filter(([path]) => path.includes('/commits/'))).toHaveLength(20)
  })
  it('does not guess a baseline from unrelated or newer tags', async () => {
    const read = vi.fn(async (path: string) => path.includes('/tags?') ? [tag('v3.0.0', base), tag('feature-only', base), tag('v1.0.0', base)] : { status: 'diverged', merge_base_commit: { sha: 'f'.repeat(40) } })
    expect((await new ReleaseMembershipReader(read).get('owner/repo', head, 'v2.0.0')).membership.status).toBe('unknown')
    expect(read).toHaveBeenCalledTimes(2)
  })
})

it('keeps consecutive equal-source tags as an empty range rather than reusing already shipped PRs', async () => {
  const read = vi.fn(async (path: string) => path.includes('/tags?') ? [tag('v2.0.0', head), tag('v1.0.0', head), tag('v0.9.0', base)] : { status: 'identical', merge_base_commit: { sha: head }, total_commits: 0, commits: [], files: [] })
  const range = await new ReleaseMembershipReader(read).get('owner/repo', head, 'v2.0.0')
  expect(range.membership).toMatchObject({ status: 'complete', baseline: 'v1.0.0', baselineSha: head })
  expect(range.pulls.size).toBe(0)
  expect(read).toHaveBeenCalledTimes(2)
})

it('reopens an unchanged tag with the current commit associations', async () => {
  let number = 1
  const read = vi.fn(async (path: string) => path.includes('/compare/')
    ? { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 2, commits: [{ sha: merge }, { sha: head }] }
    : [pull(number)])
  let now = 0
  const reader = new ReleaseMembershipReader(read, () => now)
  const tags = [tag('v1.0.0', base)]
  expect([...((await reader.get('owner/repo', head, 'v2.0.0', tags)).pulls.values())].map(row => row.number)).toEqual([1])
  number = 2
  now = 15_000
  const reopened = await reader.get('owner/repo', head, 'v2.0.0', tags)
  expect(reopened.membership.status).toBe('complete')
  expect([...reopened.pulls.values()].map(row => row.number)).toEqual([2])
})

it('updates siblings and reaches later commits despite a persistently failing lookup', async () => {
  let now = 0
  let refreshing = false
  let failing = false
  const commits = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(40, '0'))
  const read = vi.fn(async (path: string) => {
    if (path.includes('/compare/')) return { status: 'ahead', merge_base_commit: { sha: base }, total_commits: commits.length, commits: commits.map(sha => ({ sha })) }
    const commit = path.split('/commits/')[1]?.split('/')[0]
    if (commit === commits[0]) {
      if (failing) throw new Error('Read unavailable')
      return [pull(1, commits[0])]
    }
    if (commit === commits[1]) return [pull(refreshing ? 3 : 2, commits[1])]
    if (commit === commits[9]) return [pull(refreshing ? 5 : 4, commits[9])]
    return []
  })
  const reader = new ReleaseMembershipReader(read, () => now)
  const get = () => reader.get('owner/repo', head, 'v2.0.0', [tag('v1.0.0', base)])
  const numbers = (range: Awaited<ReturnType<typeof get>>) => [...range.pulls.values()].map(row => row.number)
  await get()
  now = 15_000
  expect(numbers(await get())).toEqual([1, 2, 4])

  refreshing = true
  failing = true
  now = 30_000
  expect(numbers(await get())).toEqual([1, 3, 4])
  now = 90_000
  const later = await get()
  expect(numbers(later)).toEqual([1, 3, 5])
  expect(later.membership.status).toBe('partial')
  expect(later.pulls.get('owner/repo#1')).toMatchObject({ freshness: 'stale', observedAt: new Date(0).toISOString() })
  expect(later.pulls.get('owner/repo#5')).toMatchObject({ freshness: 'fresh', observedAt: new Date(now).toISOString() })
  now = 105_000
  expect(numbers(await get())).toEqual([1, 3, 5])
  expect(read.mock.calls.filter(([path]) => path.includes(`/commits/${commits[0]}/`))).toHaveLength(3)

  failing = false
  now = 165_000
  expect((await get()).membership.status).toBe('partial')
  now = 180_000
  const recovered = await get()
  expect(recovered.membership.status).toBe('complete')
  expect(recovered.pulls.get('owner/repo#1')).toMatchObject({ freshness: 'fresh', observedAt: new Date(now).toISOString() })
})
