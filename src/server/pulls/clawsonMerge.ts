import { z } from 'zod'
import { releasePull } from '../../shared/releases'
import type { ClawsonMergeInput } from '../../shared/clawsonMerge'
import { githubJson } from './github'

const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const metadata = z.object({ head: z.object({ sha }), base: z.object({ ref: z.string() }), state: z.string(), merged: z.boolean(), draft: z.boolean(), mergeable: z.boolean().nullable() })
const requirement = z.object({ context: z.string(), app_id: z.number().nullable().optional(), integration_id: z.number().nullable().optional() })
const branchSchema = z.object({ protection: z.object({ required_status_checks: z.object({ contexts: z.array(z.string()), checks: z.array(requirement).optional() }).optional() }).optional() })
const rulesSchema = z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
const checksSchema = z.object({ total_count: z.number(), check_runs: z.array(z.object({ name: z.string(), head_sha: sha, status: z.string(), conclusion: z.string().nullable(), app: z.object({ id: z.number() }) })) })
const statusSchema = z.object({ total_count: z.number(), sha, statuses: z.array(z.object({ context: z.string(), state: z.string() })) })

/** Fresh, selected-PR reads only. Pin the command to the observed head; never execute it here. */
export async function prepareClawsonMerge(input: ClawsonMergeInput, actor: string, read = githubJson, now = Date.now) {
  const at = new Date(now()).toISOString(), pulls: Array<{ url: string; repository: string; head: string }> = []
  const problems: string[] = []
  for (const target of input.targets) {
    const identity = releasePull(target.url)
    if (!identity) throw new Error('Choose valid GitHub PR URLs.')
    const prefix = `/repos/${identity.repository}`, path = `${prefix}/pulls/${identity.number}`
    try {
      const before = metadata.parse(await read(path))
      if (before.merged) throw new Error('already merged')
      if (before.state !== 'open') throw new Error('closed')
      if (before.draft) throw new Error('still a draft')
      if (before.head.sha !== target.head) throw new Error('head changed; refresh and select it again')
      if (before.mergeable !== true) throw new Error(before.mergeable === false ? 'has merge conflicts' : 'GitHub has not confirmed whether it has conflicts; try again shortly')
      const headPath = `${prefix}/commits/${before.head.sha}`, base = encodeURIComponent(before.base.ref)
      const [branch, rules, checks, statuses] = await Promise.all([
        read(`${prefix}/branches/${base}`).then(value => branchSchema.parse(value)),
        read(`${prefix}/rules/branches/${base}?per_page=100`).then(value => rulesSchema.parse(value)),
        read(`${headPath}/check-runs?per_page=100&filter=latest`).then(value => checksSchema.parse(value)),
        read(`${headPath}/status?per_page=100`).then(value => statusSchema.parse(value)),
      ])
      // Partial evidence could hide a red or missing required check.
      if (checks.total_count !== checks.check_runs.length || statuses.total_count !== statuses.statuses.length || rules.length === 100) throw new Error('check or branch-rule evidence is incomplete')
      if (statuses.sha !== before.head.sha || checks.check_runs.some(check => check.head_sha !== before.head.sha)) throw new Error('checks do not match the selected head')
      const required: z.infer<typeof requirement>[] = [...(branch.protection?.required_status_checks?.checks ?? []), ...(branch.protection?.required_status_checks?.contexts ?? []).map(context => ({ context })),
        ...rules.filter(rule => rule.type === 'required_status_checks').flatMap(rule => z.object({ required_status_checks: z.array(requirement) }).parse(rule.parameters).required_status_checks)]
      const green = (check: typeof checks.check_runs[number]) => check.status === 'completed' && ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '')
      for (const check of checks.check_runs) if (!green(check)) throw new Error(`${check.name} is ${check.status !== 'completed' ? 'pending' : check.conclusion ?? 'not green'}`)
      for (const status of statuses.statuses) if (status.state !== 'success') throw new Error(`${status.context} is ${status.state}`)
      for (const check of required) {
        const app = check.integration_id ?? check.app_id
        const checkPassed = checks.check_runs.some(row => row.name === check.context && (app == null || app === -1 || row.app.id === app) && green(row))
        const statusPassed = (app == null || app === -1) && statuses.statuses.some(row => row.context === check.context && row.state === 'success')
        if (!checkPassed && !statusPassed) throw new Error(`required check ${check.context} is missing or not green`)
      }
      const after = metadata.parse(await read(path))
      if (after.head.sha !== before.head.sha || after.base.ref !== before.base.ref) throw new Error('head or base changed during the check; refresh and select it again')
      if (after.merged || after.state !== 'open' || after.draft || after.mergeable !== true) throw new Error('PR state changed during the check; refresh and try again')
      pulls.push({ url: identity.url, repository: identity.repository, head: before.head.sha })
    } catch (error) { problems.push(`${identity.url}: ${error instanceof z.ZodError ? 'GitHub returned incomplete merge evidence' : (error as Error).message}.`) }
  }
  if (problems.length) throw new Error(`Nothing sent to Clawson. ${problems.join(' ')}`)
  const repos = [...new Set(pulls.map(pull => pull.repository))]
  const title = `Admin merge ${pulls.length} PR${pulls.length === 1 ? '' : 's'}`
  const detailedTitle = `${title}: ${repos.join(', ')}`
  return { at, name: detailedTitle.length <= 200 ? detailedTitle : `${title} across ${repos.length} repositories`,
    brief: `Owner merge word\n${actor} gave the Merge action via Tin Star’s “Send to Clawson for admin merge” button at ${at}. This authorizes only the PR URLs at the exact heads listed below. Nothing else is authorized.\n\nSteps\nBefore EACH merge, re-read the PR head and all required checks at that exact head. All required checks must be green. Stop and report on this card if any check is red, pending, missing or unknown, the head has changed, or there is a conflict. Do not update branches, change heads, bypass failed checks, substitute PRs, or retry with a different head.\n\n${pulls.map((pull, index) => `${index + 1}. ${pull.url}\nExact head SHA: ${pull.head}\nRequired checks verified green at this head when sent.\nCommand: gh pr merge ${pull.url} --squash --admin --match-head-commit ${pull.head}`).join('\n\n')}\n\nReturn\nPost one comment per PR on this card with its PR URL, exact head SHA, command result, and merge result (including the resulting commit URL on success). On any stop, post the reason and do not continue the batch.` }
}
