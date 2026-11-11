import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sign } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import yaml from 'js-yaml'
import { operationSchema, readerRepositories, type ActionOperation, type ActionSnapshot } from '../../shared/actions'
import { readActionJob, readActionSnapshot } from './evidence'
import { BrokerEffectError, simulatedRequest } from './broker'
import type { RunnerResource } from './sandbox'

const id = z.number().int().positive().safe()
const app = z.object({ appId: id, installations: z.array(z.object({ installationId: id, repositories: z.record(id) }).strict()).min(1) }).strict()
export const brokerConfigSchema = z.object({
  webUid: id, ownerLogins: z.array(z.string().min(1)).min(1), reviewAuthor: z.string().min(1),
  custody: z.string().default('/var/lib/tinstar-action-broker/credentials'),
  socket: z.string().default('/run/tinstar-action-broker/broker.sock'),
  actions: z.string().default('/var/lib/tinstar-action-broker/actions'),
  runtime: z.string().default('/var/lib/tinstar-action-broker/runtime'),
  reader: app.optional(), repair: app.optional(),
}).strict()
export type BrokerConfig = z.infer<typeof brokerConfigSchema>
type Profile = 'reader' | 'repair'
type Permissions = Record<string, 'read' | 'write'>
export type ProviderRequest = { method: 'GET' | 'POST' | 'PUT'; path: string; authorization: string; body?: unknown }
export type ProviderTransport = (input: ProviderRequest) => Promise<{ status: number; data: unknown }>
/** No subprocess, env or argv receives authentication. HTTPS stays inside the
 * broker process; gh-axi has no secret-in-memory input interface. No redirects,
 * arbitrary origins, automatic retries or provider diagnostics leave custody. */
export const githubTransport: ProviderTransport = input => new Promise((resolveResponse, reject) => {
  const request = httpsRequest({ hostname: 'api.github.com', port: 443, method: input.method, path: input.path,
    headers: { Authorization: `Bearer ${input.authorization}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tinstar-action-broker', ...(input.body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 12_000,
  }, response => {
    let bytes = 0; const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) request.destroy(); else chunks.push(chunk) })
    response.on('error', () => reject(new Error('GitHub broker request failed')))
    response.on('end', () => {
      try { resolveResponse({ status: response.statusCode ?? 0, data: bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }) }
      catch { reject(new Error('GitHub broker response was not JSON')) }
    })
  })
  request.on('timeout', () => request.destroy())
  request.on('error', () => reject(new Error('GitHub broker request failed')))
  request.end(input.body ? JSON.stringify(input.body) : undefined)
})

/** Path scope prevents a caller turning Reader into an unrestricted HTTP proxy.
 * Permissions are derived here; callers cannot supply permissions or headers. */
export function readerScope(path: string): { repository: string; permissions: Permissions } {
  if (!path.startsWith('/repos/') || /[\\#\r\n]/.test(path)) throw new Error('Reader path outside approved scope')
  const parsed = new URL(path, 'https://api.github.com')
  if (parsed.pathname + parsed.search !== path || parsed.origin !== 'https://api.github.com') throw new Error('Reader path outside approved scope')
  const match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(parsed.pathname)
  if (!match || !readerRepositories.includes(match[1] as typeof readerRepositories[number])) throw new Error('Repository outside approved ten-repository Reader scope')
  const suffix = match[2]!, permissions: Permissions = { metadata: 'read' }
  if (!suffix) { /* Repository numeric ID/owner verification. */ }
  else if (/^\/pulls(?:\/[1-9]\d*(?:\/(?:files|reviews|commits))?)?$/.test(suffix)) permissions.pull_requests = 'read'
  else if (/^\/commits\/[a-f0-9]{40,64}\/pulls$/.test(suffix)) permissions.pull_requests = 'read'
  else if (suffix === '/tags' || suffix === '/releases' || /^\/compare\/[a-f0-9]{40,64}\.\.\.[a-f0-9]{40,64}$/.test(suffix) || /^\/commits\/[a-f0-9]{40,64}$/.test(suffix)) permissions.contents = 'read'
  else if (/^\/commits\/[a-f0-9]{40,64}\/check-runs$/.test(suffix)) permissions.checks = 'read'
  else if (/^\/commits\/[a-f0-9]{40,64}\/(?:status|statuses)$/.test(suffix)) permissions.statuses = 'read'
  else if (/^\/actions\/(?:runs(?:\/[1-9]\d*(?:\/jobs)?)?|jobs\/[1-9]\d*|workflows\/[1-9]\d*)$/.test(suffix)) permissions.actions = 'read'
  else if (/^\/rules\/branches\/[^/]+$/.test(suffix)) { /* Active branch rules require metadata read only. */ }
  else if (/^\/branches\/[^/]+$/.test(suffix) || /^\/contents\/\.github\/workflows\/[\w.-]+\.ya?ml$/.test(suffix)) permissions.contents = 'read'
  else throw new Error('Reader operation outside PR evidence scope')
  for (const [key, value] of parsed.searchParams) {
    if (key === 'page' && /^[1-9]\d{0,2}$/.test(value) || key === 'per_page' && /^(?:[1-9]\d?|100)$/.test(value) ||
      key === 'state' && ['open', 'closed', 'all'].includes(value) || key === 'filter' && value === 'latest' ||
      key === 'event' && value === 'push' && suffix === '/actions/runs' ||
      key === 'head_sha' && /^[a-f0-9]{40,64}$/.test(value) || key === 'ref' && /^[a-f0-9]{40,64}$/.test(value)) continue
    throw new Error('Reader query outside PR evidence scope')
  }
  return { repository: match[1]!, permissions }
}

export class LiveProvider {
  #tokens = new Map<string, { token: string; until: number }>()
  #secrets = new Set<string>()
  constructor(readonly config: BrokerConfig, private transport: ProviderTransport = githubTransport, private enabled = process.env.TINSTAR_ACTIONS_LIVE === 'reader-repair') {
    if (config.reader && config.repair && config.reader.appId === config.repair.appId) throw new Error('Reader and Repair require distinct App identities')
    for (const profile of ['reader', 'repair'] as const) {
      const entries = config[profile]?.installations.flatMap(installation => Object.entries(installation.repositories)) ?? []
      if (new Set(entries.map(([name]) => name)).size !== entries.length || new Set(entries.map(([, value]) => value)).size !== entries.length) throw new Error('Duplicate repository mapping in App config')
      if (entries.some(([repository]) => profile === 'reader' ? !readerRepositories.includes(repository as typeof readerRepositories[number]) : repository !== 'fortresspower/cmsandbox')) throw new Error('App config exceeds approved repository scope')
    }
  }
  redact(value: unknown): unknown {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return null
    let safe = encoded
    for (const secret of this.#secrets) safe = safe.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]')
    return JSON.parse(safe)
  }
  private mapping(profile: Profile, repository: string) {
    const app = this.config[profile]
    const installation = app?.installations.find(row => Object.hasOwn(row.repositories, repository))
    if (!this.enabled || !app || !installation) throw new Error(`Live ${profile} not provisioned: enable reader-repair and configure its App/installation/repository IDs and private key`)
    return { app, installation, repositoryId: installation.repositories[repository]! }
  }
  private async key(profile: Profile): Promise<string> {
    try {
      const directory = await stat(this.config.custody)
      if (resolve(this.config.custody) !== this.config.custody || !directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()) throw new Error()
      const file = await open(join(this.config.custody, `${profile}.pem`), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) throw new Error()
        const key = await file.readFile('utf8'); this.#secrets.add(key); return key
      } finally { await file.close() }
    } catch { throw new Error(`Live ${profile} not provisioned: broker-owned 0700 custody and 0600 private key required`) }
  }
  private async token(profile: Profile, repository: string, permissions: Permissions) {
    const { app, installation, repositoryId } = this.mapping(profile, repository)
    const cacheKey = JSON.stringify([profile, repositoryId, permissions])
    const cached = this.#tokens.get(cacheKey)
    if (cached && cached.until > Date.now() + 60_000) return cached.token
    const key = await this.key(profile)
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(app.appId) })).toString('base64url')
    let jwt: string
    try { jwt = `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key).toString('base64url')}` }
    catch { throw new Error(`Live ${profile} not provisioned: invalid App private key`) }
    this.#secrets.add(jwt)
    let response
    try { response = await this.transport({ method: 'POST', path: `/app/installations/${installation.installationId}/access_tokens`, authorization: jwt, body: { repository_ids: [repositoryId], permissions } }) }
    catch { throw new Error('App installation token request failed; no ambient authentication fallback') }
    // The token never leaves this closure, including malformed/overbroad responses.
    const raw = z.object({ token: z.string().min(1), expires_at: z.string(), permissions: z.record(z.string()), repositories: z.array(z.object({ id, full_name: z.string() })) }).safeParse(response.data)
    const possibleToken = z.object({ token: z.string().min(1) }).safeParse(response.data)
    if (possibleToken.success) this.#secrets.add(possibleToken.data.token)
    if (response.status !== 201 || !raw.success) throw new Error('App installation token response rejected')
    const token = raw.data, expires = Date.parse(token.expires_at)
    if (!Number.isFinite(expires) || expires <= Date.now() + 60_000 || expires > Date.now() + 3_660_000 ||
      Object.entries(token.permissions).some(([name, value]) => permissions[name] !== value) || Object.entries(permissions).some(([name, value]) => token.permissions[name] !== value) ||
      token.repositories.length !== 1 || token.repositories[0]!.id !== repositoryId || token.repositories[0]!.full_name.toLowerCase() !== repository) throw new Error('App installation token exceeds requested repository/permission scope')
    this.#tokens.set(cacheKey, { token: token.token, until: expires })
    return token.token
  }
  private async call(profile: Profile, repository: string, permissions: Permissions, method: ProviderRequest['method'], path: string, body?: unknown, beforeSend?: () => Promise<void>) {
    let authorization: string
    try { authorization = await this.token(profile, repository, permissions); await beforeSend?.() }
    catch (error) { throw new BrokerEffectError(error instanceof Error ? error.message : 'Broker validation refused request', 'not-sent') }
    let response
    try { response = await this.transport({ method, path, body, authorization }) }
    catch { throw new BrokerEffectError('GitHub broker request failed; outcome unknown, no automatic retry', 'unknown') }
    if (response.status < 200 || response.status >= 300) throw new BrokerEffectError(`GitHub broker request refused (${response.status}); no retry or permission expansion`, response.status >= 500 ? 'unknown' : 'not-sent')
    return { status: response.status, data: this.redact(response.data) }
  }
  read = async (path: string, _projection = '.'): Promise<unknown> => {
    const { repository, permissions } = readerScope(path)
    return (await this.call('reader', repository, permissions, 'GET', path)).data
  }
  snapshot = (url: string) => readActionSnapshot(url, this.read)
  async identity() {
    if (!this.enabled || !this.config.reader) throw new Error('Live Reader not provisioned')
    const repositories: string[] = [], owners = new Set<string>()
    for (const installation of this.config.reader.installations) for (const [repository, repositoryId] of Object.entries(installation.repositories)) {
      const observed = z.object({ id, full_name: z.string(), owner: z.object({ login: z.string() }) }).parse(await this.read(`/repos/${repository}`))
      if (observed.id !== repositoryId || observed.full_name.toLowerCase() !== repository || observed.owner.login.toLowerCase() !== repository.split('/')[0]) throw new Error('Reader installation repository identity mismatch')
      repositories.push(repository); owners.add(observed.owner.login.toLowerCase())
    }
    return { account: this.config.reviewAuthor.toLowerCase(), owners: [...owners], repositories, authenticatedActor: 'Tin Star Reader App', credentialProfile: 'Reader' }
  }
  runnerRead = (target: ActionSnapshot, resource: RunnerResource) => {
    const prefix = `/repos/${target.repository}`
    const paths: Record<RunnerResource, string> = { pr: `${prefix}/pulls/${target.number}`, files: `${prefix}/pulls/${target.number}/files?per_page=100`,
      reviews: `${prefix}/pulls/${target.number}/reviews?per_page=100`, checks: `${prefix}/commits/${target.head}/check-runs?per_page=100&filter=latest`,
      statuses: `${prefix}/commits/${target.head}/status`, runs: `${prefix}/actions/runs?head_sha=${target.head}&per_page=100` }
    return this.read(paths[resource])
  }
  async job(repository: string, jobId: number) {
    const job = await readActionJob(repository, jobId, this.read)
    // A current head file cannot prove the historical graph of PR-merge-ref runs.
    // Only a push run uses the exact selected commit's workflow file. Unknown or
    // dynamic names/needs, matrices and reusable workflows remain a visible hold.
    const run = z.object({ event: z.string(), path: z.string(), head_sha: z.string() }).parse(await this.read(`/repos/${repository}/actions/runs/${job.runId}`))
    const rawJob = z.object({ name: z.string() }).parse(await this.read(`/repos/${repository}/actions/jobs/${jobId}`))
    if (run.event !== 'push' || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(run.path)) return job
    const file = z.object({ encoding: z.literal('base64'), content: z.string() }).parse(await this.read(`/repos/${repository}/contents/${run.path}?ref=${run.head_sha}`))
    const workflow = z.object({ jobs: z.record(z.object({ name: z.string().optional(), needs: z.union([z.string(), z.array(z.string())]).optional(), strategy: z.unknown().optional(), uses: z.string().optional() }).passthrough()) }).safeParse(yaml.load(Buffer.from(file.content, 'base64').toString('utf8')))
    if (!workflow.success) return job
    const jobs = Object.entries(workflow.data.jobs)
    if (jobs.some(([key, value]) => value.strategy || value.uses || /\$\{\{/.test(key + (value.name ?? '') + JSON.stringify(value.needs)))) return job
    const matches = jobs.filter(([key, value]) => (value.name ?? key) === rawJob.name)
    if (matches.length !== 1) return job
    const selected = matches[0]![0]
    if (jobs.some(([, value]) => [value.needs].flat().includes(selected))) return job
    return { ...job, dependentJobs: [] as number[] }
  }
  async perform(target: ActionSnapshot, operation: ActionOperation, signal?: AbortSignal) {
    signal?.throwIfAborted()
    operation = operationSchema.parse(operation)
    if (operation.kind === 'merge.admin') throw new Error('Admin Merge is globally disabled; no live Merge adapter exists')
    if (target.repository !== 'fortresspower/cmsandbox' || !['repair.update', 'repair.rerun'].includes(operation.kind)) throw new Error('Live operation outside Reader/Repair scope')
    if (target.headRepository !== target.repository || target.state !== 'open' || target.draft || target.protectedHead || !target.headRef || target.headRef === 'main' || target.headRef.startsWith('refs/') || target.headRef.startsWith('release/')) throw new Error('Repair requires the selected open unprotected same-repository PR head')
    if (operation.kind === 'repair.update' && operation.ref !== `refs/heads/${target.headRef}`) throw new Error('Repair ref differs from selected PR head')
    // This adapter can only reach two fixed endpoints. The executor's shared
    // grant/head/job validation and durable intent precede entry here.
    const request = simulatedRequest(target, operation)
    if (!request || !('expectedHead' in operation) || operation.expectedHead !== target.head) throw new Error('Repair expected HEAD mismatch')
    const permissions: Permissions = operation.kind === 'repair.update' ? { metadata: 'read', contents: 'write', pull_requests: 'write' } : { metadata: 'read', actions: 'write' }
    const response = await this.call('repair', target.repository, permissions, request.method as 'PUT' | 'POST', request.path, request.body, async () => {
      const current = await this.snapshot(target.url)
      if (current.head !== target.head || current.base !== target.base || current.baseHead !== target.baseHead || current.headRef !== target.headRef || current.headRepository !== target.headRepository || current.state !== 'open' || current.draft || current.protectedHead) throw new Error('Expected HEAD/base or selected PR state changed immediately before Repair')
      if (operation.kind === 'repair.rerun') {
        const job = await this.job(target.repository, operation.jobId)
        const run = z.object({ head_branch: z.string() }).parse(await this.read(`/repos/${target.repository}/actions/runs/${operation.runId}`))
        if (job.runId !== operation.runId || job.head !== target.head || run.head_branch !== target.headRef || job.status !== 'completed' || job.conclusion !== 'failure' || job.runAttempt !== 1 || job.dependentJobs === null || job.dependentJobs.length) throw new Error('Selected failed job/run/head changed immediately before rerun')
      }
      signal?.throwIfAborted()
    })
    if (response.status !== (operation.kind === 'repair.update' ? 202 : 201)) throw new Error('Repair response ambiguous; outcome unknown, no automatic retry')
    return { providerRequest: request, actualGitHubWrites: 1, resultingSha: null, verification: 'accepted' as const,
      result: `GitHub accepted ${operation.kind}; completion is not verified. No automatic retry, merge or deployment claimed.` }
  }
}
