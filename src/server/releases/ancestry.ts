import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readGithubScalars } from '../reconciliation/queuePulls'

const execute = promisify(execFile)
export interface AncestryRead { state: 'ancestor' | 'not-ancestor' | 'unknown'; reason?: string }
export type AncestryCheck = (repository: string, checkout: string, mergeSha: string, deployedSha: string) => Promise<AncestryRead>
export const githubRepository = (remote: string) => remote.trim().replace(/\.git$/, '').match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/)?.[1]?.toLowerCase() ?? null
/** Same bounded authenticated reader as PR observations. No local clone needed.
 * Truncated history cannot rule out a revert and therefore remains unknown. */
export function githubReleaseAncestry(read = readGithubScalars): AncestryCheck {
  return async (repository, _checkout, mergeSha, deployedSha) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || ![mergeSha, deployedSha].every(sha => /^[a-f0-9]{40,64}$/.test(sha))) return { state: 'unknown', reason: 'Missing repository/source identity' }
    const compare = (base: string, head: string) => read(`/repos/${repository}/compare/${base}...${head}?per_page=100`, '{status,merge_base_sha:.merge_base_commit.sha,total:.total_commits,returned:(.commits|length),shas:([.commits[].sha]|join(",")),reverts:([.commits[].commit.message|scan("This reverts commit ([a-fA-F0-9]{40,64})")|.[0]]|join(","))}')
    try {
      if (mergeSha === deployedSha) return { state: 'ancestor' }
      const history = await compare(mergeSha, deployedSha)
      if (!['ahead', 'behind', 'diverged', 'identical'].includes(String(history.status)) || typeof history.merge_base_sha !== 'string') throw new Error('Incomplete comparison')
      if (history.merge_base_sha !== mergeSha) return { state: 'not-ancestor' }
      if (typeof history.total !== 'number' || history.total !== history.returned || typeof history.reverts !== 'string') return { state: 'unknown', reason: 'GitHub descendant history is incomplete; supply a local mirror for full revert inspection' }
      const reverted = String(history.reverts).toLowerCase().split(',').filter(Boolean)
      if (!reverted.length) return { state: 'ancestor' }
      const introduced = new Set([mergeSha])
      const merge = await read(`/repos/${repository}/commits/${mergeSha}`, '{parents:(.parents|length),first_parent:.parents[0].sha}')
      if (typeof merge.parents !== 'number') throw new Error('Merge parents unknown')
      if (merge.parents > 1) {
        if (typeof merge.first_parent !== 'string') throw new Error('Merge parent unknown')
        const commits = await compare(merge.first_parent, mergeSha)
        if (typeof commits.total !== 'number' || commits.total !== commits.returned || typeof commits.shas !== 'string') throw new Error('Introduced merge commits truncated')
        for (const sha of commits.shas.split(',')) introduced.add(sha)
      }
      return reverted.some(sha => introduced.has(sha)) ? { state: 'unknown', reason: 'A descendant commit explicitly reverts this merge' } : { state: 'ancestor' }
    } catch { return { state: 'unknown', reason: 'GitHub ancestry or revert history unavailable' } }
  }
}
const githubAncestry = githubReleaseAncestry()
/** Read existing local objects only: no fetch, checkout, index edit or network mutation. */
export const checkReleaseAncestry: AncestryCheck = async (repository, checkout, mergeSha, deployedSha) => {
  if (checkout === 'github') return githubAncestry(repository, checkout, mergeSha, deployedSha)
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
    const parents = (await git(['rev-list', '--parents', '-n', '1', mergeSha])).stdout.trim().split(/\s+/).slice(1)
    const introduced = parents.length > 1
      ? (await git(['rev-list', mergeSha, `^${parents[0]}`])).stdout.trim().split(/\s+/)
      : [mergeSha]
    const revertedCommits = new Set(introduced)
    const history = await git(['log', '--format=%B', `${mergeSha}..${deployedSha}`])
    if ([...history.stdout.matchAll(/This reverts commit ([a-f0-9]{40,64})\b/gi)].some(match => revertedCommits.has(match[1]!.toLowerCase()))) return { state: 'unknown', reason: 'A descendant commit explicitly reverts this merge' }
    return { state: 'ancestor' }
  } catch { return { state: 'unknown', reason: 'Repository identity or ancestry could not be read' } }
}
