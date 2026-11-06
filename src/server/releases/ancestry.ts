import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export interface AncestryRead { state: 'ancestor' | 'not-ancestor' | 'unknown'; reason?: string }
export type AncestryCheck = (repository: string, checkout: string, mergeSha: string, deployedSha: string) => Promise<AncestryRead>
export const githubRepository = (remote: string) => remote.trim().replace(/\.git$/, '').match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/)?.[1]?.toLowerCase() ?? null
/** Read existing local objects only: no fetch, checkout, index edit or network mutation. */
export const checkReleaseAncestry: AncestryCheck = async (repository, checkout, mergeSha, deployedSha) => {
  if (![mergeSha, deployedSha].every(sha => /^[a-f0-9]{40,64}$/.test(sha))) return { state: 'unknown', reason: 'Missing immutable source commit identity' }
  const git = (args: string[]) => execute('git', ['--no-replace-objects', '-C', checkout, ...args], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  try {
    const remote = await git(['remote', 'get-url', 'origin'])
    if (githubRepository(remote.stdout) !== repository.toLowerCase()) return { state: 'unknown', reason: 'Configured checkout belongs to a different repository' }
    try { await git(['merge-base', '--is-ancestor', mergeSha, deployedSha]) }
    catch (error) {
      return (error as { code?: unknown }).code === 1 ? { state: 'not-ancestor' } : { state: 'unknown', reason: 'Git ancestry objects unavailable; update the configured read-only mirror' }
    }
    // An ancestor can have been reverted. Detect standard Git revert provenance
    // locally without publishing commit prose; other known exceptions come from receipts.
    const history = await git(['log', '--format=%B', `${mergeSha}..${deployedSha}`])
    if (new RegExp(`This reverts commit ${mergeSha}\\b`, 'i').test(history.stdout)) return { state: 'unknown', reason: 'A descendant commit explicitly reverts this merge' }
    return { state: 'ancestor' }
  } catch { return { state: 'unknown', reason: 'Repository identity or ancestry could not be read' } }
}
