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
  it('retains precise partial progress without inventing an empty release on a failed read', async () => {
    let now = 0
    const commits = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(40, '0'))
    const read = vi.fn(async (path: string) => path.includes('/tags?') ? [tag('v1.0.0', base)] : path.includes('/compare/') ? { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 10, commits: commits.map(sha => ({ sha })) } : [pull(1, commits[0]!)])
    const reader = new ReleaseMembershipReader(read, () => now)
    const first = await reader.get('owner/repo', head, 'v2.0.0')
    expect(first.membership.status).toBe('partial'); expect(first.cursor).toBe(8)
    now = 20_000; read.mockRejectedValueOnce(new Error('Read unavailable'))
    const failed = await reader.get('owner/repo', head, 'v2.0.0')
    expect(failed.membership.status).toBe('partial'); expect(failed.pulls.size).toBe(1)
    now = 90_000
    const resumed = await reader.get('owner/repo', head, 'v2.0.0')
    expect(resumed.membership.status).toBe('complete'); expect(resumed.pulls.size).toBe(1)
  })
  it('does not guess a baseline from unrelated or newer tags', async () => {
    const read = vi.fn(async (path: string) => path.includes('/tags?') ? [tag('v3.0.0', base), tag('feature-only', base), tag('v1.0.0', base)] : { status: 'diverged', merge_base_commit: { sha: 'f'.repeat(40) } })
    expect((await new ReleaseMembershipReader(read).get('owner/repo', head, 'v2.0.0')).membership.status).toBe('unknown')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
