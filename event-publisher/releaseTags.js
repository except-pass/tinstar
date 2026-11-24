import { GitHubReadError, githubReader } from './github.js'

export const tagRepository = 'fortresspower/cmsandbox'
export const tagInterval = 90
export const tagSource = {
  source_id: 'github:cmsandbox-tags', provider: 'github', type: 'tag', mode: 'live', home_path: null,
  coverage: 'cmsandbox version tags and exact-SHA Releases evidence',
  command: 'GitHub REST conditional GET /tags',
}
export const pendingTagEvidence = {
  pulls: { coverage: 'pending', items: [] },
  cards: { coverage: 'pending', items: [] },
  runs: { coverage: 'pending', items: [] },
}

const releasesEndpoint = 'http://127.0.0.1:5281/api/releases'
const tagPattern = /^v\d+\.\d+\.\d+$/
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
const isPullUrl = url => typeof url === 'string' && /^https:\/\/github\.com\/fortresspower\/cmsandbox\/pull\/[1-9]\d*$/.test(url)
const verifiedPull = pull => isPullUrl(pull.url) && isSha(pull.mergeSha) && pull.state === 'merged' && pull.freshness === 'fresh'

function tagPage(rows) {
  if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => typeof row?.name !== 'string' || !isSha(row.commit?.sha))) {
    throw new GitHubReadError('unreadable GitHub tag page')
  }
  return rows.map(row => [row.name, row.commit.sha])
}

function cardLink(id) {
  if (typeof id !== 'string') return null
  if (/^[a-f0-9]{32}$/.test(id)) return `https://www.notion.so/${id}`
  const jira = /^jira:(fortresspower-jira\.atlassian\.net):[1-9]\d*:([1-9]\d*)$/.exec(id)
  return jira && `https://${jira[1]}/secure/IssueNavigator.jspa?jql=${encodeURIComponent(`id = ${jira[2]}`)}`
}

function releaseEvidence(data, { tag, sha }) {
  if (!data?.releaseSource || data.releaseSource.status === 'unknown') return null
  const release = data.releases?.find(record =>
    record.repository === tagRepository && record.version === tag && record.sourceSha === sha && record.kind === 'production')
  if (!release) return null

  const range = release.membership?.status ?? 'unknown'
  const rangePulls = release.pulls ?? []
  const verified = new Map(rangePulls.filter(verifiedPull).map(pull => [pull.url, { pull, basis: 'range' }]))
  const associations = new Map((data.pulls ?? []).map(pull => [pull.url, pull]))
  const links = new Map([...associations].map(([url, pull]) => [url, (pull.links ?? []).flatMap(link => {
    const cardUrl = link.active && !pull.exceptions?.includes(`Linked card unavailable: ${link.cardId}`) && cardLink(link.cardId)
    return cardUrl ? [{ pull: url, card_id: link.cardId, url: cardUrl }] : []
  })]))
  const ancestry = new Map((release.containedPulls ?? []).map(row => [row.pull, row]))
  let ancestryPending = false
  for (const [url, pull] of associations) {
    if (verified.has(url) || !isPullUrl(url) || !links.get(url).length) continue
    if (pull.freshness === 'fresh' && (pull.state === 'open' || pull.state === 'closed')) continue
    const proof = ancestry.get(url)
    if (!verifiedPull(pull) || !proof || proof.mergeSha !== pull.mergeSha || proof.state === 'unknown') {
      ancestryPending = true
    } else if (proof.state === 'included') {
      verified.set(url, { pull, basis: 'ancestry' })
    }
  }
  const pulls = [...verified.values()].sort((a, b) => a.pull.url.localeCompare(b.pull.url))
  const coverage = range === 'complete' && (!data.associationsComplete || ancestryPending ||
    rangePulls.some(pull => !verifiedPull(pull))) ? 'partial' : range
  const cards = data.associationsComplete ? pulls.flatMap(({ pull }) => links.get(pull.url) ?? [])
    .sort((a, b) => a.pull.localeCompare(b.pull) || a.card_id.localeCompare(b.card_id)) : []
  const freshRuns = release.github?.runsStatus === 'fresh'
  const runs = (release.github?.runs ?? [])
    .filter(run => run.sha === sha && Number.isSafeInteger(run.id) && run.id > 0 &&
      run.url === `https://github.com/${tagRepository}/actions/runs/${run.id}` &&
      typeof run.workflow === 'string')
    .map(run => ({ id: run.id, url: run.url, workflow: run.workflow, status: run.status, conclusion: run.conclusion, attempt: run.attempt,
      freshness: freshRuns ? 'fresh' : 'last_known' }))
    .sort((a, b) => a.id - b.id)

  return {
    pulls: { coverage, items: pulls.map(({ pull, basis }) => ({ url: pull.url, merge_sha: pull.mergeSha, basis })) },
    cards: { coverage: data.associationsComplete ? coverage : 'unknown', items: cards,
      availableLinks: data.associationsComplete ? links : undefined },
    runs: { coverage: freshRuns ? 'complete' : 'unknown', items: runs },
  }
}

export function releaseTagObserver({ reader = githubReader(), fetchEndpoint = fetch, now = () => new Date() } = {}) {
  let pages = []
  return async (journal, signal) => {
    const startedAt = now().toISOString()
    let tags, reason = null
    try {
      const sampled = []
      const catalog = new Map()
      for (let page = 1; ; page++) {
        const result = await reader.sample(`repos/${tagRepository}/tags?per_page=100&page=${page}`, pages[page - 1], tagPage, signal)
        sampled.push(result)
        for (const [name, sha] of result.value) {
          // Page boundaries can shift when refs change during enumeration.
          if (catalog.has(name)) throw new GitHubReadError('GitHub tag pages overlapped; will retry the inventory')
          catalog.set(name, sha)
        }
        if (result.value.length < 100) break
      }
      pages = sampled
      tags = new Map([...catalog].filter(([name]) => tagPattern.test(name)))
    } catch (error) {
      reason = error instanceof GitHubReadError ? error.message : 'GitHub tag inventory could not be read'
    }
    if (signal?.aborted) return
    const accepted = journal.recordReleaseTags({ startedAt, observedAt: now().toISOString(), tags, reason })

    const target = journal.nextReleaseTagEvidence(now().toISOString())
    if (!target) return accepted
    let detail = null
    try {
      const url = new URL(releasesEndpoint)
      url.searchParams.set('tag', target.tag)
      const timeout = AbortSignal.timeout(8000)
      const response = await fetchEndpoint(url, {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (response.ok) {
        const body = await response.json()
        if (body?.ok === true) detail = releaseEvidence(body.data, target)
      } else await response.body?.cancel()
    } catch {
      // Inventory was already committed. Missing enrichment retries independently.
    }
    if (signal?.aborted) return
    const complete = detail && Object.values(detail).every(group => group.coverage === 'complete') &&
      detail.runs.items.length > 0 && detail.runs.items.every(run => run.status === 'completed')
    const observedAt = now()
    journal.recordReleaseTagEvidence(target, detail, observedAt.toISOString(),
      new Date(observedAt.getTime() + (complete ? 3600 : tagInterval) * 1000).toISOString())
    return accepted
  }
}
