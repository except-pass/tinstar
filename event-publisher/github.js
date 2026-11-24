import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const githubSource = {
  source_id: 'github:linked-pulls', provider: 'github', type: 'pr', mode: 'live', home_path: null,
  coverage: 'allowlisted repositories with verified PR links from active live First Mate tasks; current PR and head check runs',
  command: 'GitHub REST conditional GET',
}
export const githubInterval = 300

const run = promisify(execFile)
const pullsPerPass = 4
const coreReserve = 1000
const pullUrl = /^https:\/\/github\.com\/([a-z0-9_-][a-z0-9._-]*\/(?!\.{1,2}\/)[a-z0-9._-]+)\/pull\/([1-9]\d{0,14})$/
export const repositoryPattern = /^[a-z0-9_-][a-z0-9._-]*\/(?!\.{1,2}$)[a-z0-9._-]+$/i
const sha = /^[a-f0-9]{40}$/
const checkStates = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'])
const conclusions = new Set(['action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out'])

export class GitHubReadError extends Error {}

function prFields(body, repository, number) {
  const fullName = body?.base?.repo?.full_name
  if (body?.number !== number || typeof fullName !== 'string' || fullName.toLowerCase() !== repository ||
      !['open', 'closed'].includes(body.state) || typeof body.merged !== 'boolean' ||
      (body.merged && (body.state !== 'closed' || !sha.test(body.merge_commit_sha))) ||
      typeof body.draft !== 'boolean' || !sha.test(body.head?.sha ?? '') ||
      typeof body.updated_at !== 'string' || !Number.isFinite(Date.parse(body.updated_at))) {
    throw new GitHubReadError('unverified PR response')
  }
  return {
    state: body.merged ? 'merged' : body.state,
    head_sha: body.head.sha,
    // For an unmerged PR this field can name a temporary test merge.
    merge_sha: body.merged ? body.merge_commit_sha : null,
    draft: body.draft,
    updated_at: new Date(body.updated_at).toISOString(),
  }
}

function checkFields(body, repository, head, headers) {
  if (headers.has('link') && /rel="next"/.test(headers.get('link')) ||
      !Array.isArray(body?.check_runs) || body.total_count !== body.check_runs.length ||
      body.check_runs.length > 100) throw new GitHubReadError('head check inventory incomplete')
  const ids = new Set()
  return body.check_runs.map(check => {
    if (typeof check?.url !== 'string' ||
        check.url.toLowerCase() !== `https://api.github.com/repos/${repository}/check-runs/${check.id}` ||
        !Number.isSafeInteger(check.id) || check.id < 1 || ids.has(check.id) || check.head_sha !== head ||
        !checkStates.has(check.status) || !(check.conclusion === null || conclusions.has(check.conclusion))) {
      throw new GitHubReadError('unverified head check response')
    }
    ids.add(check.id)
    return { id: check.id, status: check.status, conclusion: check.conclusion }
  }).sort((a, b) => a.id - b.id)
}

function githubDiff(before, after, { snapshot, startedAt }) {
  const { checks, updated_at, ...fields } = after
  if (before && updated_at < before.updated_at) return null
  const changes = before ? Object.entries(fields)
    .filter(([field, value]) => before[field] !== value)
    .map(([field, value]) => ({
      event_type: field === 'state' ? `pr.${value === 'open' ? 'opened' : value}` : 'pr.updated',
      change: { field, before: before[field], after: value },
    })) : [{ event_type: 'pr.observed', change: { after: fields } }]

  const baseline = before?.check_inventory
  const previous = before?.head_sha === fields.head_sha && baseline?.head === fields.head_sha ? baseline : null
  if (checks !== undefined && (!previous || JSON.stringify(previous.runs) !== JSON.stringify(checks))) {
    changes.push({
      event_type: previous ? 'pr.checks.changed' : 'pr.checks.observed',
      change: { field: 'checks', ...(previous ? { before: previous.runs } : {}), after: checks },
      previous,
    })
  }
  const inventory = checks === undefined ? previous :
    { head: fields.head_sha, runs: checks, snapshot_id: snapshot, started_at: startedAt }
  return { changes, fields: { ...fields, updated_at, check_inventory: inventory } }
}

async function githubGet(path, etag, signal) {
  const args = ['api', '--hostname', 'github.com', '--method', 'GET', '--include',
    '--header', 'Accept: application/vnd.github+json', path]
  if (etag) args.push('--header', `If-None-Match: ${etag}`)
  let stdout
  try {
    ({ stdout } = await run('gh', args, {
      timeout: 10_000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
    }))
  } catch (error) {
    if (!error.stdout || error.killed || signal?.aborted) throw new GitHubReadError('GitHub CLI read failed')
    // gh returns a nonzero exit code for HTTP errors and 304.
    stdout = error.stdout
  }
  const boundary = /\r?\n\r?\n/.exec(stdout)
  if (!boundary) throw new GitHubReadError('GitHub CLI did not return HTTP headers')
  const [status, ...headerLines] = stdout.slice(0, boundary.index).split(/\r?\n/)
  const headers = new Map(headerLines.map(line => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
  }))
  return { status: Number(/^HTTP\/\S+ (\d{3})\b/.exec(status)?.[1]), headers,
    body: stdout.slice(boundary.index + boundary[0].length) }
}

export function githubReader({ get = githubGet, now = () => new Date() } = {}) {
  let notBefore = 0
  let deferReason = null

  async function sample(path, cache, normalize, signal) {
    if (now() < notBefore) throw new GitHubReadError(deferReason)
    const { status, headers, body } = await get(path, cache?.etag, signal)
    const remaining = Number(headers.get('x-ratelimit-remaining'))
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000
    const retry = Number(headers.get('retry-after')) * 1000
    const secondaryLimit = status === 403 && /secondary rate limit|abuse detection/i.test(body)
    if (remaining <= coreReserve || status === 429 || retry > 0 || secondaryLimit) {
      notBefore = Math.max(now().getTime() + Math.max(githubInterval * 1000, retry || 0),
        remaining <= coreReserve ? reset || 0 : 0)
      deferReason = remaining <= coreReserve ? 'shared GitHub API quota reserve reached' : 'GitHub asked the observer to back off'
    }
    if (status === 304 && cache) return cache
    if (status !== 200) throw new GitHubReadError(deferReason && now() < notBefore ? deferReason : `GitHub read failed (HTTP ${status || 'unknown'})`)
    if (!Number.isInteger(remaining)) throw new GitHubReadError('GitHub rate-limit metadata unavailable')
    return { etag: headers.get('etag'), value: normalize(JSON.parse(body), headers) }
  }

  return {
    sample,
    deferred: () => now() < notBefore ? deferReason : null,
  }
}

export function githubObserver({ repositories = [], get, now = () => new Date(), reader = githubReader({ get, now }) } = {}) {
  const allowed = new Set(repositories.map(repository => repository.toLowerCase()))
  const caches = new Map()
  const { sample, deferred } = reader
  const eligibleTargets = journal => new Set(journal.linkedPulls().map(({ url }) => url)
    .filter(url => allowed.has(pullUrl.exec(url)?.[1])))

  return async (journal, signal) => {
    const startedAt = now().toISOString()
    const targets = eligibleTargets(journal)
    for (const url of caches.keys()) if (!targets.has(url)) caches.delete(url)
    // Poll least recently attempted links first so a large backlog cannot starve any PR.
    const candidates = [...targets].sort((a, b) => (caches.get(a)?.attempt ?? 0) - (caches.get(b)?.attempt ?? 0))
    const entries = []
    const attempted = new Set()
    const counts = { linked: 0, observed: 0, failed: 0, deferred: 0, checks_unavailable: 0 }
    let reason = null
    for (const url of candidates.slice(0, pullsPerPass)) {
      if (signal?.aborted || deferred()) break
      if (!journal.linkedPulls(url).length) continue
      const [, repository, numberText] = pullUrl.exec(url)
      const number = Number(numberText)
      const attempt = now()
      const cache = caches.get(url) ?? {}
      cache.attempt = attempt.getTime()
      caches.set(url, cache)
      attempted.add(url)
      try {
        const pull = await sample(`repos/${repository}/pulls/${number}`, cache.pull,
          body => prFields(body, repository, number), signal)
        cache.pull = pull
        const head = pull.value.head_sha
        if (cache.head !== head) {
          cache.head = head
          cache.checks = null
        }
        let checks
        let observedAt = now().toISOString()
        try {
          if (signal?.aborted) return
          if (!journal.linkedPulls(url).length) throw new GitHubReadError('verified task link no longer available')
          checks = await sample(`repos/${repository}/commits/${head}/check-runs?filter=all&per_page=100`,
            cache.checks, (body, headers) => checkFields(body, repository, head, headers), signal)
          cache.checks = checks
          observedAt = now().toISOString()
        } catch (error) {
          counts.checks_unavailable++
          reason ??= error instanceof GitHubReadError ? error.message : 'invalid GitHub check response'
        }
        entries.push({
          id: `github:pr:${repository}#${number}`,
          startedAt: attempt.toISOString(), observedAt,
          fields: { ...pull.value, checks: checks?.value },
          evidence: {
            source_reference: { url, repository, number, head_sha: head },
            check_coverage: checks ? 'verified' : 'unavailable',
            confidence_basis: checks ? 'matching GitHub PR identity and check runs for its exact head SHA' :
              'matching GitHub PR identity',
          },
        })
        counts.observed++
      } catch (error) {
        counts.failed++
        // JSON parse errors can include response text. Only surface fixed diagnostics.
        reason ??= error instanceof GitHubReadError ? error.message : 'invalid GitHub response'
      }
    }
    if (signal?.aborted) return
    counts.deferred = [...eligibleTargets(journal)].filter(url => !attempted.has(url)).length
    counts.linked = attempted.size + counts.deferred
    const taskSources = journal.sources().filter(source =>
      source.source_id.startsWith('firstmate:home:') && source.type === 'task' && source.mode === 'live' && source.health !== 'deconfigured')
    const discoveryIncomplete = taskSources.filter(source => source.health !== 'ok' || source.counts?.pr_links_unobserved).length
    if (discoveryIncomplete) {
      counts.task_sources_incomplete = discoveryIncomplete
      reason ??= 'verified PR link discovery incomplete'
    }
    if (counts.deferred) reason ??= deferred() ?? 'some linked PRs were deferred'
    const health = reason ? entries.length ? 'partial' : 'unavailable' : counts.linked ? 'ok' : 'unconnected'
    if (health === 'unconnected') reason = 'no allowlisted PR links in the accepted live task backlog'
    return journal.recordProviderPoll(githubSource, {
      startedAt, observedAt: now().toISOString(), entries, health, reason, counts,
    }, githubDiff)
  }
}
