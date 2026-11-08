import { z } from 'zod'
import { releasePull } from '../../shared/releases'
import type { ActionSnapshot, CheckEvidence } from '../../shared/actions'
import { githubJson } from '../pulls/github'

const metadata = z.object({ number: z.number(), html_url: z.string(), state: z.enum(['open', 'closed']), merged: z.boolean(), draft: z.boolean(), mergeable: z.boolean().nullable(),
  head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }), base: z.object({ sha: z.string(), ref: z.string() }), changed_files: z.number().int().nonnegative() })
const checkSchema = z.object({ total_count: z.number(), check_runs: z.array(z.object({ id: z.number(), name: z.string(), head_sha: z.string(), status: z.string(), conclusion: z.string().nullable(), app: z.object({ id: z.number(), slug: z.string() }), details_url: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable() })) })
/** Reader selection honors the explicit live switch through githubJson.
 * No cache is used: each proposal observes the exact head immediately before validation.
 * REST reviews cannot establish resolved threads; do not invent that evidence. */
export async function readActionSnapshot(url: string, read = githubJson): Promise<ActionSnapshot> {
  const identity = releasePull(url)
  if (!identity) throw new Error('Invalid PR URL')
  const path = `/repos/${identity.repository}/pulls/${identity.number}`
  const before = metadata.parse(await read(path))
  if (before.html_url !== identity.url || before.number !== identity.number) throw new Error('Provider PR identity mismatch')
  const [files, checks, statuses, branch] = await Promise.all([
    read(`${path}/files?per_page=100`, '[.[]|{filename,previous_filename}]').then(value => z.array(z.object({ filename: z.string(), previous_filename: z.string().nullish() })).parse(value)),
    read(`/repos/${identity.repository}/commits/${before.head.sha}/check-runs?per_page=100&filter=latest`).then(value => checkSchema.parse(value)),
    read(`/repos/${identity.repository}/commits/${before.head.sha}/status`).then(value => z.object({ total_count: z.number() }).parse(value)),
    read(`/repos/${identity.repository}/branches/${encodeURIComponent(before.head.ref)}`).then(value => z.object({ protected: z.boolean() }).parse(value)).catch(() => ({ protected: true })),
  ])
  const after = metadata.parse(await read(path))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PR changed while reading evidence; refresh and replan')
  const observed: CheckEvidence[] = checks.check_runs.map(check => ({ id: check.id, name: check.name, appId: check.app.id, appSlug: check.app.slug,
    head: check.head_sha, status: check.status, conclusion: check.conclusion, url: check.details_url, startedAt: check.started_at, completedAt: check.completed_at }))
  return { ...identity, head: after.head.sha, base: after.base.ref, baseHead: after.base.sha, headRef: after.head.ref, headRepository: after.head.repo?.full_name.toLowerCase() ?? '',
    state: after.merged ? 'merged' : after.state, draft: after.draft, protectedHead: branch.protected,
    pendingMerge: after.mergeable === null ? null : false, threadsResolved: null, rulesVerified: false,
    changedPaths: [...new Set(files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))], pathsComplete: files.length === after.changed_files && files.length < 100,
    observedAt: new Date().toISOString(), checks: observed, checksComplete: checks.total_count === checks.check_runs.length && checks.check_runs.length < 100 && statuses.total_count === 0 }
}

/** Exact job + run GETs only. The job URL never comes from installed code. */
export async function readActionJob(repository: string, jobId: number, read = githubJson) {
  if (repository !== 'fortresspower/cmsandbox' || !Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Job outside Repair scope')
  const job = z.object({ id: z.number(), run_id: z.number(), status: z.string(), conclusion: z.string().nullable() }).parse(await read(`/repos/${repository}/actions/jobs/${jobId}`))
  const run = z.object({ id: z.number(), head_sha: z.string(), run_attempt: z.number(), repository: z.object({ full_name: z.string() }) }).parse(await read(`/repos/${repository}/actions/runs/${job.run_id}`))
  if (run.repository.full_name.toLowerCase() !== repository || job.id !== jobId || run.id !== job.run_id) throw new Error('Provider job/run identity mismatch')
  return { id: job.id, runId: run.id, status: job.status, conclusion: job.conclusion, head: run.head_sha, runAttempt: run.run_attempt, dependentJobs: null }
}
