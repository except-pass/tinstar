#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUT_LIMIT = 2 * 1024 * 1024
const DEFAULT_TIMEOUT = 30_000

function boundedAppend(current, chunk, limit = OUTPUT_LIMIT) {
  if (current.length >= limit) return { value: current, truncated: true }
  const text = chunk.toString('utf8')
  const remaining = Math.max(0, limit - current.length)
  return {
    value: current + text.slice(0, remaining),
    truncated: text.length > remaining,
  }
}

function signalChild(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The child may have exited between the timeout and signal delivery.
  }
}

export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let forceTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      signalChild(child, 'SIGTERM')
      forceTimer = setTimeout(() => signalChild(child, 'SIGKILL'), 5_000)
      forceTimer.unref()
    }, options.timeoutMs ?? DEFAULT_TIMEOUT)
    child.stdout.on('data', chunk => {
      const captured = boundedAppend(stdout, chunk, options.outputLimit)
      stdout = captured.value
      stdoutTruncated ||= captured.truncated
    })
    child.stderr.on('data', chunk => {
      const captured = boundedAppend(stderr, chunk, options.outputLimit)
      stderr = captured.value
      stderrTruncated ||= captured.truncated
    })
    child.on('error', error => {
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      reject(Object.assign(error, { command, args }))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      const result = { command, args, code, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut }
      if (code === 0 && !timedOut) resolveRun(result)
      else if (options.allowFailure) resolveRun(result)
      else reject(Object.assign(new Error(timedOut
        ? `${command} timed out`
        : `${command} exited ${code}: ${stderr.trim()}`), result))
    })
  })
}

async function jsonCommand(runner, command, args, options) {
  const result = await runner(command, args, options)
  try {
    return JSON.parse(result.stdout || 'null')
  } catch {
    throw new Error(`${command} returned malformed JSON`)
  }
}

function addEdge(edges, indegree, from, to) {
  if (edges.get(from).has(to)) return
  edges.get(from).add(to)
  indegree.set(to, indegree.get(to) + 1)
}

function stronglyConnected(nodes, edges) {
  let index = 0
  const indices = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const result = []
  function visit(node) {
    indices.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node)) {
      if (!indices.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node), low.get(next)))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)))
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      if (component.length > 1 || edges.get(node).has(node)) result.push(component.sort((a, b) => a - b))
    }
  }
  for (const node of nodes) if (!indices.has(node)) visit(node)
  return result.sort((a, b) => a[0] - b[0])
}

export function buildQueue(prs, options = {}) {
  const normalized = [...prs].sort((a, b) => a.number - b.number)
  const nodes = normalized.map(pr => pr.number)
  const byHead = new Map(normalized.map(pr => [pr.headRefName, pr.number]))
  const edges = new Map(nodes.map(node => [node, new Set()]))
  const indegree = new Map(nodes.map(node => [node, 0]))
  const edgeEvidence = []

  for (const pr of normalized) {
    const basePr = byHead.get(pr.baseRefName)
    if (basePr) {
      addEdge(edges, indegree, basePr, pr.number)
      edgeEvidence.push({ from: basePr, to: pr.number, source: 'base-branch' })
    }
  }
  for (const [blocked, blockers] of Object.entries(options.blockedBy ?? {})) {
    const to = Number(blocked)
    if (!edges.has(to)) continue
    for (const from of blockers.map(Number)) {
      if (!edges.has(from)) continue
      addEdge(edges, indegree, from, to)
      edgeEvidence.push({ from, to, source: 'issue-dependency' })
    }
  }
  for (const edge of options.managedStackEdges ?? []) {
    if (!edges.has(edge.from) || !edges.has(edge.to)) continue
    addEdge(edges, indegree, edge.from, edge.to)
    edgeEvidence.push({ ...edge, source: 'managed-stack' })
  }

  const ready = nodes.filter(node => indegree.get(node) === 0).sort((a, b) => a - b)
  const order = []
  while (ready.length) {
    const node = ready.shift()
    order.push(node)
    for (const next of [...edges.get(node)].sort((a, b) => a - b)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) {
        ready.push(next)
        ready.sort((a, b) => a - b)
      }
    }
  }

  const overlaps = []
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const rightFiles = new Set(normalized[right].files ?? [])
      const files = [...new Set(normalized[left].files ?? [])].filter(path => rightFiles.has(path)).sort()
      if (files.length) overlaps.push({ left: normalized[left].number, right: normalized[right].number, files })
    }
  }

  return {
    order,
    cycles: stronglyConnected(nodes, edges),
    edges: edgeEvidence.sort((a, b) => a.from - b.from || a.to - b.to || a.source.localeCompare(b.source)),
    overlaps,
    sources: {
      baseBranches: 'confirmed',
      issueDependencies: options.dependencyMetadata === 'unavailable' ? 'unknown' : 'confirmed',
      managedStack: options.managedStackEdges ? 'confirmed' : 'unknown',
    },
  }
}

export function parseWorktreePorcelain(input) {
  const records = []
  let current = null
  const fields = input.includes('\0') ? input.split('\0') : input.split('\n')
  for (const raw of fields) {
    const line = raw.replace(/^\n+/, '')
    if (!line) continue
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      if (current) records.push(current)
      current = { path: value, head: null, branch: null, detached: false, prunable: null }
    } else if (current && key === 'HEAD') current.head = value
    else if (current && key === 'branch') current.branch = value
    else if (current && key === 'detached') current.detached = true
    else if (current && key === 'prunable') current.prunable = value || true
  }
  if (current) records.push(current)
  return records
}

export function resolveMergeMethod(capabilities, blessedMethods) {
  const blessed = [...new Set(blessedMethods)].filter(method => ['squash', 'merge', 'rebase'].includes(method))
  const enabled = blessed.filter(method => capabilities[method])
  if (blessed.length && !enabled.length) return { status: 'blocked', reason: 'repository policy selects no host-enabled method' }
  if (enabled.length === 1) return { method: enabled[0], source: 'repository-policy' }
  if (enabled.length > 1) return { status: 'clarification_required', methods: enabled, reason: 'multiple blessed methods are enabled' }
  const hostEnabled = ['squash', 'merge', 'rebase'].filter(method => capabilities[method])
  return { status: 'clarification_required', methods: hostEnabled, reason: 'host capability does not establish repository preference' }
}

export function evaluateCleanup(input) {
  const blockers = []
  if (!input.merged) blockers.push('pr_not_merged')
  if (input.openPr) blockers.push('branch_has_open_pr')
  if (input.requiredByOpenPr) blockers.push('required_by_open_pr')
  if (input.worktreeDirty) blockers.push('dirty_worktree')
  if (input.localOid && input.localOid !== input.expectedHead) blockers.push('local_oid_differs_from_pr_head')
  if (!input.sameRepository) blockers.push('external_fork_branch')
  return { pruneable: blockers.length === 0, blockers }
}

export function scrubEnvironment(env = process.env) {
  const clean = {}
  const safePath = String(env.PATH ?? '').split(':').filter(entry => entry.startsWith('/')).join(':')
  if (safePath) clean.PATH = safePath
  for (const key of ['LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
    if (env[key]) clean[key] = env[key]
  }
  clean.CI = '1'
  return clean
}

function normalizePrState(pr) {
  return String(pr.state ?? '').toUpperCase()
}

export async function mergePullRequest({ pr, expectedHead, method, capabilities = null, runner = run, pollAttempts = 3 }) {
  if (!['squash', 'merge', 'rebase'].includes(method)) return { status: 'invalid_method', method }
  const fields = 'number,state,headRefOid,isCrossRepository,mergedAt,url'
  const before = await jsonCommand(runner, 'gh', ['pr', 'view', String(pr), '--json', fields])
  if (normalizePrState(before) !== 'OPEN') return { status: 'not_open', observed: before }
  if (before.headRefOid !== expectedHead) {
    return { status: 'head_changed', expectedHead, observedHead: before.headRefOid }
  }
  const enabled = capabilities ?? (await repositoryIdentity(runner)).capabilities
  if (!enabled[method]) return { status: 'method_disabled', method }
  const methodFlag = { squash: '--squash', merge: '--merge', rebase: '--rebase' }[method]
  try {
    await runner('gh', ['pr', 'merge', String(pr), methodFlag, '--match-head-commit', expectedHead])
  } catch (error) {
    return { status: 'merge_failed', message: error.message, expectedHead }
  }
  let observed = before
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    observed = await jsonCommand(runner, 'gh', ['pr', 'view', String(pr), '--json', fields])
    if (normalizePrState(observed) === 'MERGED' || observed.mergedAt) {
      return { status: 'merged', expectedHead, observed }
    }
    if (attempt + 1 < pollAttempts) await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
  }
  return { status: 'queued_or_open', expectedHead, observed }
}

async function repositoryIdentity(runner = run) {
  const view = await jsonCommand(runner, 'gh', ['repo', 'view', '--json', 'nameWithOwner'])
  const repository = await jsonCommand(runner, 'gh', ['api', `repos/${view.nameWithOwner}`])
  return {
    nameWithOwner: view.nameWithOwner,
    defaultBranch: repository.default_branch,
    capabilities: {
      squash: Boolean(repository.allow_squash_merge),
      merge: Boolean(repository.allow_merge_commit),
      rebase: Boolean(repository.allow_rebase_merge),
      deleteBranchOnMerge: Boolean(repository.delete_branch_on_merge),
    },
  }
}

async function getDependencyMetadata(repo, number, runner = run) {
  const path = `repos/${repo}/issues/${number}/dependencies/blocked_by`
  const result = await runner('gh', ['api', '--paginate', '--slurp', path], { allowFailure: true })
  if (result.code !== 0) return { status: 'unknown', blockedBy: [], detail: result.stderr.trim() }
  try {
    const data = JSON.parse(result.stdout || '[]')
    const pages = Array.isArray(data) ? data : [data]
    const items = pages.flatMap(page => Array.isArray(page) ? page : page.items ?? page.blocked_by ?? [])
    return { status: 'confirmed', blockedBy: items.map(item => item.number).filter(Number.isInteger) }
  } catch {
    return { status: 'unknown', blockedBy: [], detail: 'dependency endpoint returned malformed JSON' }
  }
}

async function readPolicyEvidence(runner = run) {
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'docs/contributing.md']
  const tracked = await runner('git', ['ls-files', '--', ...candidates], { allowFailure: true })
  const lines = []
  for (const path of tracked.stdout.split('\n').filter(Boolean)) {
    try {
      const content = await readFile(resolve(path), 'utf8')
      for (const [index, line] of content.split('\n').entries()) {
        if (/\b(squash|merge method|rebase|merge commit)\b/i.test(line)) {
          lines.push({ path, line: index + 1, text: line.trim().slice(0, 500) })
        }
      }
    } catch {
      // A disappearing policy file is reported by omission; host capability remains separate.
    }
  }
  return lines
}

async function worktreeInventory(runner = run) {
  let result = await runner('git', ['worktree', 'list', '--porcelain', '-z'], { allowFailure: true })
  if (result.code !== 0) result = await runner('git', ['worktree', 'list', '--porcelain'])
  const records = parseWorktreePorcelain(result.stdout)
  return Promise.all(records.map(async record => {
    if (record.prunable) {
      record.clean = null
      return record
    }
    const status = await runner('git', ['-C', record.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFailure: true })
    record.clean = status.code === 0 ? status.stdout.length === 0 : null
    record.statusDigest = status.code === 0
      ? createHash('sha256').update(status.stdout).digest('hex')
      : null
    return record
  }))
}

async function refInventory(runner = run) {
  const result = await runner('git', [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(upstream:short)%00',
    'refs/heads',
    'refs/remotes/origin',
  ])
  const fields = result.stdout.split('\0')
  const refs = []
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const name = fields[index].replace(/^\n+/, '').trim()
    const oid = fields[index + 1].trim()
    const upstream = fields[index + 2].trim()
    if (name && oid) refs.push({ name, oid, upstream: upstream || null })
  }
  return refs
}

const PR_FIELDS = 'number,title,body,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,url,updatedAt,files,commits,reviews,author,additions,deletions,changedFiles,mergedAt,headRepository,headRepositoryOwner'
const QUEUE_FIELDS = 'number,title,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,url,updatedAt,files,mergedAt,headRepository'
const MERGED_FIELDS = 'number,title,state,headRefName,headRefOid,baseRefName,isCrossRepository,url,mergedAt,headRepository'
const CLEANUP_FIELDS = 'number,state,headRefName,headRefOid,isCrossRepository,mergedAt,headRepository'

function normalizeFiles(pr) {
  return {
    ...pr,
    files: (pr.files ?? []).map(file => typeof file === 'string' ? file : file.path),
  }
}

async function inspectPr(number, runner = run) {
  const pr = await jsonCommand(runner, 'gh', ['pr', 'view', String(number), '--json', PR_FIELDS])
  const diff = await runner('gh', ['pr', 'diff', String(number), '--patch'], { allowFailure: true, outputLimit: OUTPUT_LIMIT })
  return {
    ...normalizeFiles(pr),
    patch: diff.stdout,
    patchStatus: diff.code === 0 ? (diff.stdoutTruncated ? 'truncated' : 'available') : 'unknown',
    untrustedFields: ['title', 'body', 'patch', 'reviews', 'commits', 'statusCheckRollup', 'files'],
  }
}

export async function inspectRepository({ includeMerged = false, runner = run } = {}) {
  const repo = await repositoryIdentity(runner)
  const open = await jsonCommand(runner, 'gh', ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', QUEUE_FIELDS])
  const details = open.map(pr => ({
    ...normalizeFiles(pr),
    untrustedFields: ['title', 'statusCheckRollup', 'files'],
  }))
  const blockedBy = {}
  let dependencyStatus = 'unknown'
  for (const item of open) {
    const dependency = await getDependencyMetadata(repo.nameWithOwner, item.number, runner)
    blockedBy[item.number] = dependency.blockedBy
    dependencyStatus = dependency.status === 'confirmed' && dependencyStatus !== 'unavailable' ? 'confirmed' : 'unavailable'
  }
  const queue = buildQueue(details, {
    blockedBy,
    dependencyMetadata: dependencyStatus === 'confirmed' ? 'confirmed' : 'unavailable',
  })
  let merged = []
  if (includeMerged) {
    merged = await jsonCommand(runner, 'gh', ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', MERGED_FIELDS])
  }
  const extensions = await runner('gh', ['extension', 'list'], { allowFailure: true })
  return {
    status: 'ok',
    repository: repo,
    capabilities: {
      git: 'available',
      gh: 'available',
      issueDependencies: dependencyStatus === 'confirmed' ? 'available' : 'unknown',
      managedStack: /(^|\s)gh-stack(\s|$)/m.test(extensions.stdout) ? 'extension-present-unconfirmed' : 'unavailable',
    },
    policyEvidence: await readPolicyEvidence(runner),
    openPullRequests: details,
    mergedPullRequests: merged,
    refs: await refInventory(runner),
    worktrees: await worktreeInventory(runner),
    queue,
  }
}

async function optionalRef(ref, runner = run) {
  const result = await runner('git', ['show-ref', '--verify', '--hash', ref], { allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : null
}

function isInside(path, parent) {
  const pathFromParent = relative(resolve(parent), resolve(path))
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent))
}

export async function cleanupPullRequest({ pr: number, expectedHead, runner = run }) {
  const repo = await repositoryIdentity(runner)
  const pr = await jsonCommand(runner, 'gh', ['pr', 'view', String(number), '--json', CLEANUP_FIELDS])
  const open = await jsonCommand(runner, 'gh', ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,baseRefName'])
  const branch = pr.headRefName
  const worktrees = (await worktreeInventory(runner)).filter(record => record.branch === `refs/heads/${branch}`)
  const localOid = await optionalRef(`refs/heads/${branch}`, runner)
  const remote = await runner('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { allowFailure: true })
  if (remote.code !== 0) {
    return { status: 'blocked', branch, blocker: 'remote_branch_state_unknown' }
  }
  const remoteOid = remote.stdout.trim().split(/\s+/)[0] || null
  const headRepo = pr.headRepository?.nameWithOwner ?? pr.headRepository?.name ?? null
  const sameRepository = !pr.isCrossRepository && (!headRepo || headRepo === repo.nameWithOwner || basename(repo.nameWithOwner) === headRepo)
  const requiredBy = open.filter(item => item.number !== number && item.baseRefName === branch).map(item => item.number)
  const hasOpenPr = open.some(item => item.number !== number && item.headRefName === branch)
  const current = resolve(process.cwd())
  const currentWorktree = worktrees.find(record => isInside(current, record.path))
  const eligibility = evaluateCleanup({
    merged: normalizePrState(pr) === 'MERGED' || Boolean(pr.mergedAt),
    openPr: hasOpenPr,
    requiredByOpenPr: requiredBy.length > 0,
    worktreeDirty: worktrees.some(record => record.clean !== true),
    localOid,
    expectedHead,
    sameRepository,
  })
  if (pr.headRefOid && pr.headRefOid !== expectedHead) eligibility.blockers.push('recorded_pr_head_mismatch')
  if (remoteOid && remoteOid !== expectedHead) eligibility.blockers.push('remote_oid_differs_from_pr_head')
  if (branch === repo.defaultBranch) eligibility.blockers.push('default_branch')
  if (currentWorktree) eligibility.blockers.push('current_worktree')
  eligibility.pruneable = eligibility.blockers.length === 0
  if (!eligibility.pruneable) return { status: 'blocked', branch, requiredBy, ...eligibility }

  const actions = []
  for (const worktree of worktrees) {
    await runner('git', ['worktree', 'remove', worktree.path])
    actions.push({ action: 'remove_worktree', path: worktree.path })
  }
  if (localOid) {
    await runner('git', ['update-ref', '-d', `refs/heads/${branch}`, expectedHead])
    actions.push({ action: 'delete_local_branch', branch, oid: expectedHead })
  }
  if (remoteOid) {
    try {
      await runner('git', [
        'push',
        `--force-with-lease=refs/heads/${branch}:${expectedHead}`,
        'origin',
        `:refs/heads/${branch}`,
      ])
      actions.push({ action: 'delete_remote_branch', branch, oid: expectedHead })
    } catch (error) {
      await runner('git', ['worktree', 'prune'])
      return { status: 'partial', branch, actions, residue: [{ action: 'delete_remote_branch', message: error.message }] }
    }
  }
  await runner('git', ['worktree', 'prune'])
  actions.push({ action: 'prune_worktree_metadata' })
  return { status: 'cleaned', branch, actions }
}

function syncToken(branch, localOid, remoteOid, path, statusDigest) {
  return createHash('sha256').update(`tidy-repo-sync\0${branch}\0${localOid ?? ''}\0${remoteOid}\0${path ?? ''}\0${statusDigest ?? ''}`).digest('hex').slice(0, 24)
}

async function aheadBehind(localRef, remoteRef, runner = run) {
  const result = await runner('git', ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`])
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number)
  return { ahead, behind }
}

export async function syncDefaultBranch({ approvalToken = null, runner = run } = {}) {
  const repo = await repositoryIdentity(runner)
  const branch = repo.defaultBranch
  await runner('git', ['fetch', '--prune', 'origin'])
  const localRef = `refs/heads/${branch}`
  const remoteRef = `refs/remotes/origin/${branch}`
  const remoteOid = await optionalRef(remoteRef, runner)
  if (!remoteOid) return { status: 'blocked', blocker: 'remote_default_missing', branch }
  const localOid = await optionalRef(localRef, runner)
  if (!localOid) {
    await runner('git', ['update-ref', localRef, remoteOid])
    return { status: 'synced', branch, ahead: 0, behind: 0, action: 'create_local_ref' }
  }
  const relation = await aheadBehind(localRef, remoteRef, runner)
  if (relation.ahead > 0) {
    return { status: 'blocked', blocker: relation.behind > 0 ? 'diverged' : 'local_ahead', branch, ...relation }
  }
  if (relation.behind === 0) return { status: 'synced', branch, ...relation, action: 'none' }
  const worktree = (await worktreeInventory(runner)).find(record => record.branch === localRef)
  if (!worktree) {
    await runner('git', ['update-ref', localRef, remoteOid, localOid])
    return { status: 'synced', branch, ahead: 0, behind: 0, action: 'fast_forward_ref' }
  }
  if (worktree.clean === null) {
    return { status: 'blocked', blocker: 'default_worktree_status_unknown', branch, ...relation }
  }
  if (worktree.clean) {
    await runner('git', ['-C', worktree.path, 'merge', '--ff-only', remoteRef])
    return { status: 'synced', branch, ahead: 0, behind: 0, action: 'fast_forward_checkout' }
  }
  const token = syncToken(branch, localOid, remoteOid, worktree.path, worktree.statusDigest)
  if (approvalToken !== token) {
    return {
      status: 'approval_required', branch, ahead: 0, behind: relation.behind,
      approvalToken: token,
      proposedAction: 'stash tracked and untracked changes, fast-forward, then reapply',
    }
  }
  const stashName = `tidy-repo:${branch}:${new Date().toISOString()}`
  const previousStash = await optionalRef('refs/stash', runner)
  await runner('git', ['-C', worktree.path, 'stash', 'push', '--include-untracked', '-m', stashName])
  const stashOid = (await runner('git', ['-C', worktree.path, 'rev-parse', 'refs/stash'])).stdout.trim()
  if (!stashOid || stashOid === previousStash) {
    return { status: 'blocked', blocker: 'stash_not_created', branch, stashName }
  }
  try {
    await runner('git', ['-C', worktree.path, 'merge', '--ff-only', remoteRef])
  } catch (error) {
    return { status: 'blocked', blocker: 'fast_forward_failed_after_stash', stashName, stashOid, message: error.message }
  }
  try {
    await runner('git', ['-C', worktree.path, 'stash', 'apply', '--index', stashOid])
  } catch (error) {
    return { status: 'reapply_conflict', branch, stashName, stashOid, message: error.message }
  }
  const stashList = await runner('git', ['-C', worktree.path, 'stash', 'list', '--format=%H%x00%gd%x00'])
  const stashFields = stashList.stdout.split('\0')
  let stashSelector = null
  for (let index = 0; index + 1 < stashFields.length; index += 2) {
    const oid = stashFields[index].replace(/^\n+/, '').trim()
    const selector = stashFields[index + 1].trim()
    if (oid === stashOid) stashSelector = selector
  }
  if (!stashSelector) return { status: 'partial', branch, action: 'stash_fast_forward_reapply', residue: [{ blocker: 'applied_stash_selector_missing', stashOid }] }
  await runner('git', ['-C', worktree.path, 'stash', 'drop', stashSelector])
  const verified = await aheadBehind(localRef, remoteRef, runner)
  return { status: 'synced', branch, ...verified, action: 'stash_fast_forward_reapply', stashName }
}

export async function runCheck({ pr: number, expectedHead, command, approveExternal = false, runner = run }) {
  if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== 'string')) {
    return { status: 'invalid_command' }
  }
  const pr = await jsonCommand(runner, 'gh', ['pr', 'view', String(number), '--json', 'number,state,headRefOid,isCrossRepository'])
  if (normalizePrState(pr) !== 'OPEN') return { status: 'not_open', observed: pr }
  if (pr.headRefOid !== expectedHead) return { status: 'head_changed', expectedHead, observedHead: pr.headRefOid }
  if (pr.isCrossRepository && !approveExternal) return { status: 'approval_required', reason: 'external_fork_code' }
  const parent = await mkdtemp(join(tmpdir(), 'tidy-repo-check-'))
  const worktree = join(parent, 'checkout')
  try {
    await runner('git', ['worktree', 'add', '--detach', worktree, expectedHead])
  } catch (error) {
    let registered = true
    try {
      registered = (await worktreeInventory(runner)).some(record => resolve(record.path) === resolve(worktree))
    } catch {
      // Unknown registration state must retain the path for manual inspection.
    }
    if (!registered) {
      await rm(parent, { recursive: true, force: true })
      return { status: 'check_error', message: error.message, cleanup: 'removed_unregistered_setup_directory' }
    }
    return { status: 'check_error', message: error.message, cleanup: 'retained_setup_residue', worktree }
  }
  let execution
  try {
    execution = await runner(command[0], command.slice(1), {
      cwd: worktree,
      env: scrubEnvironment(process.env),
      allowFailure: true,
      timeoutMs: 10 * 60_000,
      outputLimit: OUTPUT_LIMIT,
    })
    const status = await runner('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFailure: true })
    if (status.code === 0 && status.stdout.length === 0) {
      await runner('git', ['worktree', 'remove', worktree])
      await rm(parent, { recursive: true, force: true })
      return {
        status: execution.code === 0 ? 'passed' : 'failed',
        command,
        head: expectedHead,
        exitCode: execution.code,
        stdout: execution.stdout,
        stderr: execution.stderr,
        cleanup: 'removed',
      }
    }
    return {
      status: execution.code === 0 ? 'passed_with_residue' : 'failed_with_residue',
      command, head: expectedHead, exitCode: execution.code,
      stdout: execution.stdout, stderr: execution.stderr,
      cleanup: 'retained_dirty_worktree', worktree,
    }
  } catch (error) {
    const status = await runner('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFailure: true })
    if (status.code === 0 && status.stdout.length === 0) {
      const removal = await runner('git', ['worktree', 'remove', worktree], { allowFailure: true })
      if (removal.code === 0) {
        await rm(parent, { recursive: true, force: true })
        return { status: 'check_error', message: error.message, cleanup: 'removed' }
      }
      return { status: 'check_error', message: error.message, cleanup: 'retained_worktree_remove_failed', worktree }
    }
    return { status: 'check_error', message: error.message, cleanup: 'retained_dirty_worktree', worktree }
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`)
    const key = value.slice(2)
    if (['include-merged', 'approve-external'].includes(key)) flags[key] = true
    else {
      if (index + 1 >= rest.length) throw new Error(`missing value for --${key}`)
      flags[key] = rest[index + 1]
      index += 1
    }
  }
  return { command, flags }
}

function required(flags, key) {
  if (!flags[key]) throw new Error(`--${key} is required`)
  return flags[key]
}

async function main(argv) {
  const { command, flags } = parseArgs(argv)
  if (command === 'inspect') return inspectRepository({ includeMerged: Boolean(flags['include-merged']) })
  if (command === 'inspect-pr') return { status: 'ok', pullRequest: await inspectPr(Number(required(flags, 'pr'))) }
  if (command === 'merge') return mergePullRequest({
    pr: Number(required(flags, 'pr')),
    expectedHead: required(flags, 'head'),
    method: required(flags, 'method'),
  })
  if (command === 'cleanup') return cleanupPullRequest({
    pr: Number(required(flags, 'pr')),
    expectedHead: required(flags, 'head'),
  })
  if (command === 'sync') return syncDefaultBranch({ approvalToken: flags['approval-token'] ?? null })
  if (command === 'check') return runCheck({
    pr: Number(required(flags, 'pr')),
    expectedHead: required(flags, 'head'),
    command: JSON.parse(required(flags, 'command-json')),
    approveExternal: Boolean(flags['approve-external']),
  })
  throw new Error('usage: tidy-repo.mjs inspect [--include-merged] | inspect-pr --pr N | merge --pr N --head OID --method squash|merge|rebase | cleanup --pr N --head OID | sync [--approval-token TOKEN] | check --pr N --head OID --command-json JSON [--approve-external]')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = ['blocked', 'invalid_method', 'method_disabled', 'invalid_command', 'head_changed', 'not_open', 'merge_failed', 'check_error'].includes(result.status) ? 2 : 0
  }).catch(error => {
    process.stdout.write(`${JSON.stringify({ status: 'error', message: error.message }, null, 2)}\n`)
    process.exitCode = 1
  })
}
