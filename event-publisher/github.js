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
export const repositoryPattern = /^[a-z0-9_-][a-z0-9._-]*\/(?:\*|(?!\.{1,2}$)[a-z0-9._-]+)$/i
const sha = /^[a-f0-9]{40}$/
const checkStates = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'])
const conclusions = new Set(['action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out'])

class GitHubReadError extends Error {}

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

export function githubDiff(before, after) {
  const { checks, updated_at, ...fields } = after
  if (before && updated_at < before.updated_at) return null
  const changes = before ? Object.entries(fields)
    .filter(([field, value]) => before[field] !== value)
    .map(([field, value]) => ({
      event_type: field === 'state' ? `pr.${value === 'open' ? 'opened' : value}` : 'pr.updated',
      change: { field, before: before[field], after: value },
    })) : [{ event_type: 'pr.observed', change: { after: fields } }]
  const priorChecks = before?.head_sha === fields.head_sha ? before.checks : null
  if (JSON.stringify(priorChecks ?? []) !== JSON.stringify(checks)) {
    changes.push({
      event_type: priorChecks ? 'pr.checks.changed' : 'pr.checks.observed',
      change: { field: 'checks', ...(priorChecks ? { before: priorChecks } : {}), after: checks },
    })
  }
  return changes
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

export function githubObserver({ repositories = [], get = githubGet, now = () => new Date() } = {}) {
  const allowed = new Set(repositories.map(repository => repository.toLowerCase()))
  const caches = new Map()
  let notBefore = 0
  let deferReason = null

  async function sample(path, cache, normalize, signal) {
    if (now() < notBefore) throw new GitHubReadError(deferReason)
    const { status, headers, body } = await get(path, cache?.etag, signal)
    const remaining = Number(headers.get('x-ratelimit-remaining'))
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000
    const retry = Number(headers.get('retry-after')) * 1000
    if (remaining <= coreReserve || status === 429 || retry > 0) {
      notBefore = Math.max(now().getTime() + Math.max(githubInterval * 1000, retry || 0),
        remaining <= coreReserve ? reset || 0 : 0)
      deferReason = remaining <= coreReserve ? 'shared GitHub API quota reserve reached' : 'GitHub asked the observer to back off'
    }
    if (status === 304 && cache) return cache
    if (status !== 200) throw new GitHubReadError(deferReason && now() < notBefore ? deferReason : `GitHub read failed (HTTP ${status || 'unknown'})`)
    if (!Number.isInteger(remaining)) throw new GitHubReadError('GitHub rate-limit metadata unavailable')
    return { etag: headers.get('etag'), value: normalize(JSON.parse(body), headers) }
  }

  return async (journal, signal) => {
    const startedAt = now().toISOString()
    const targets = new Map()
    for (const { url, task_id } of journal.linkedPulls()) {
      const repository = pullUrl.exec(url)?.[1]
      if (!repository || !allowed.has(repository) && !allowed.has(`${repository.split('/')[0]}/*`)) continue
      if (!targets.has(url)) targets.set(url, [])
      targets.get(url).push({
        relation: 'linked-task',
        subject: { type: 'task', id: task_id },
      })
    }
    for (const url of caches.keys()) if (!targets.has(url)) caches.delete(url)
    // Poll least recently attempted links first so a large backlog cannot starve any PR.
    const candidates = [...targets.keys()].sort((a, b) => (caches.get(a)?.attempt ?? 0) - (caches.get(b)?.attempt ?? 0))
    const entries = []
    const counts = { linked: targets.size, observed: 0, failed: 0, deferred: 0 }
    let reason = null
    for (const url of candidates.slice(0, pullsPerPass)) {
      if (signal?.aborted || now() < notBefore) break
      const [, repository, numberText] = pullUrl.exec(url)
      const number = Number(numberText)
      const attempt = now()
      const cache = caches.get(url) ?? {}
      cache.attempt = attempt.getTime()
      caches.set(url, cache)
      try {
        const pull = await sample(`repos/${repository}/pulls/${number}`, cache.pull,
          body => prFields(body, repository, number), signal)
        cache.pull = pull
        const head = pull.value.head_sha
        const checks = await sample(`repos/${repository}/commits/${head}/check-runs?filter=all&per_page=100`,
          cache.head === head ? cache.checks : null, (body, headers) => checkFields(body, repository, head, headers), signal)
        cache.head = head
        cache.checks = checks
        entries.push({
          id: `github:pr:${repository}#${number}`,
          startedAt: attempt.toISOString(), observedAt: now().toISOString(),
          fields: { ...pull.value, checks: checks.value },
          related: targets.get(url),
          evidence: {
            source_reference: { url, repository, number, head_sha: head },
            confidence_basis: 'matching GitHub PR identity and check runs for its exact head SHA',
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
    counts.deferred = counts.linked - counts.observed - counts.failed
    if (!counts.linked) reason = 'no allowlisted PR links in the accepted live task backlog'
    else if (now() < notBefore) reason = deferReason
    else if (counts.deferred) reason ??= 'poll budget rotates through linked PRs'
    const health = !counts.linked ? 'unconnected' : reason ? entries.length ? 'partial' : 'unavailable' : 'ok'
    return journal.recordProviderPoll(githubSource, {
      startedAt, observedAt: now().toISOString(), entries, health, reason, counts,
    }, githubDiff)
  }
}
