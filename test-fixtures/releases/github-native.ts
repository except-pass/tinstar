/** Representative GitHub wire data: the historical tag had component push runs
 * but no GitHub Release. These fixtures never claim current PROD readback. */
export const nativeRepo = 'fortresspower/cmsandbox'
export const nativeBase = '0a3feeef99394f476b7562fa4dd6780ab7b17b07'
export const nativeHead = '466a3e27918a8f17a21546a6b4664d318f5fcc6a'
export const nativeTime = '2026-11-11T14:00:00Z'
export const nativeTags = [
  { name: 'v1.24.0', commit: { sha: nativeHead } },
  { name: 'v1.22.0', commit: { sha: nativeBase } },
  { name: 'deploy/v1.24.0-siteconfig-1', commit: { sha: nativeHead } },
]
export const nativeRun = {
  id: 42644291188, name: 'RA Command', path: '.github/workflows/ra-command.yml',
  html_url: `https://github.com/${nativeRepo}/actions/runs/42644291188`,
  head_sha: nativeHead, head_branch: 'v1.24.0', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1,
  created_at: '2026-11-06T12:00:00Z', updated_at: '2026-11-06T12:10:00Z', run_started_at: '2026-11-06T12:01:00Z',
}
export const nativeBody = `Operator notes retained outside generated evidence.
<!-- native-production-release:start -->
## Production release evidence
Tag [v1.24.0](https://github.com/${nativeRepo}/tree/v1.24.0) · selected commit [${nativeHead}](https://github.com/${nativeRepo}/commit/${nativeHead})
Snapshot: ${nativeTime} · [refresh run](https://github.com/${nativeRepo}/actions/runs/100)

**Awaiting PROD verification.** A green workflow is not deployed-state or smoke evidence.
| Intended target | Actions result | Native evidence |
| --- | --- | --- |
| ra-command | completed — awaiting PROD verification | [run 42644291188, attempt 1](${nativeRun.html_url}) |
<!-- native-production-release:end -->`
export const nativeRecord = { tag_name: 'v1.24.0', html_url: `https://github.com/${nativeRepo}/releases/tag/v1.24.0`, body: nativeBody, published_at: nativeTime, draft: false }
export function nativeFixtureRead(options: { tags?: typeof nativeTags; records?: unknown[]; runs?: unknown[] } = {}) {
  return async (path: string): Promise<unknown> => {
    if (path.includes('/tags?')) return options.tags ?? nativeTags
    if (path.includes('/releases?')) return options.records ?? []
    if (path.includes('/actions/runs?')) {
      const runs = path.includes(nativeHead) ? options.runs ?? [nativeRun] : []
      return { total_count: runs.length, workflow_runs: runs }
    }
    if (path.includes('/compare/')) return { status: 'ahead', total_commits: 1, merge_base_commit: { sha: nativeBase }, commits: [{ sha: nativeHead }], files: [{ filename: 'components/ra-command/app.ts' }] }
    if (path.includes('/pulls?')) return [{ number: 3267, title: 'Improve command delivery', html_url: `https://github.com/${nativeRepo}/pull/3267`, merged_at: '2026-11-06T11:00:00Z', merge_commit_sha: nativeHead, head: { sha: nativeHead }, base: { ref: 'main' } }]
    throw new Error(`Unexpected fixture GET ${path}`)
  }
}
