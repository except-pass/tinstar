import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'vitest'

import { discoverSlashCommands } from '../src/server/sessions/slashCommandRegistry'
import {
  buildQueue,
  cleanupPullRequest,
  evaluateCleanup,
  mergePullRequest,
  parseWorktreePorcelain,
  resolveMergeMethod,
  run as execRun,
  runCheck,
  scrubEnvironment,
  syncDefaultBranch,
} from '../agent-skills/skills/tidy-repo/scripts/tidy-repo.mjs'

const skillRoot = resolve('agent-skills/skills/tidy-repo')

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  // The managed sandbox can attach EPERM to a successful spawnSync result.
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git exited ${result.status}`)
  return String(result.stdout ?? '').trim()
}

async function createRepositoryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tidy-repo-git-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const local = join(root, 'local')
  await mkdir(seed)
  git(root, 'init', '--bare', remote)
  git(seed, 'init', '-b', 'main')
  git(seed, 'config', 'user.email', 'test@example.com')
  git(seed, 'config', 'user.name', 'Tidy Test')
  await writeFile(join(seed, 'file.txt'), 'one\n')
  git(seed, 'add', 'file.txt')
  git(seed, 'commit', '-m', 'initial')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'main')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'clone', remote, local)
  git(local, 'config', 'user.email', 'test@example.com')
  git(local, 'config', 'user.name', 'Tidy Test')

  const runner = async (command, args, options = {}) => {
    if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'owner/repo' }), stderr: '' }
    }
    if (command === 'gh' && args[0] === 'api') {
      return { code: 0, stdout: JSON.stringify({
        default_branch: 'main', allow_squash_merge: true,
        allow_merge_commit: false, allow_rebase_merge: false,
        delete_branch_on_merge: false,
      }), stderr: '' }
    }
    if (command === 'git') {
      const scopedArgs = args[0] === '-C' ? args : ['-C', local, ...args]
      return execRun('git', scopedArgs, options)
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  return { root, remote, seed, local, runner }
}

test('skill package declares the interactive safety contract', () => {
  const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
  const helper = readFileSync(join(skillRoot, 'scripts/tidy-repo.mjs'), 'utf8')
  assert.match(skill, /^name: tidy-repo$/m)
  assert.match(skill, /one PR at a time/i)
  assert.match(skill, /surprising omissions/i)
  assert.match(skill, /explicit approval/i)
  assert.match(skill, /untrusted data/i)
  assert.match(skill, /head commit/i)
  assert.match(skill, /closed-unmerged/i)
  assert.doesNotMatch(skill, /--admin|reset --hard|worktree remove --force/)
  assert.doesNotMatch(helper, /['"]--admin['"]|reset.+--hard|worktree.+--force/)
  assert.match(helper, /--force-with-lease=refs\/heads\//)
  for (const path of [
    'agents/openai.yaml',
    'references/briefing-contract.md',
    'references/safety-contract.md',
    'scripts/tidy-repo.mjs',
  ]) {
    assert.doesNotThrow(() => readFileSync(join(skillRoot, path)))
  }
})

test('dependency queue puts hard prerequisites first and overlap stays advisory', () => {
  const result = buildQueue([
    { number: 3, headRefName: 'three', baseRefName: 'main', files: ['shared.ts'] },
    { number: 2, headRefName: 'two', baseRefName: 'one', files: ['shared.ts'] },
    { number: 1, headRefName: 'one', baseRefName: 'main', files: ['one.ts'] },
  ], { blockedBy: { 3: [2] } })

  assert.deepEqual(result.order, [1, 2, 3])
  assert.deepEqual(result.cycles, [])
  assert.deepEqual(result.overlaps, [{ left: 2, right: 3, files: ['shared.ts'] }])
})

test('dependency queue reports cycles and unknown metadata', () => {
  const result = buildQueue([
    { number: 1, headRefName: 'one', baseRefName: 'two', files: [] },
    { number: 2, headRefName: 'two', baseRefName: 'one', files: [] },
  ], { dependencyMetadata: 'unavailable' })

  assert.deepEqual(result.order, [])
  assert.deepEqual(result.cycles, [[1, 2]])
  assert.equal(result.sources.issueDependencies, 'unknown')

  const selfCycle = buildQueue([
    { number: 9, headRefName: 'nine', baseRefName: 'main', files: [] },
  ], { blockedBy: { 9: [9] } })
  assert.deepEqual(selfCycle.cycles, [[9]])
})

test('worktree porcelain parser preserves paths and branch identities', () => {
  const input = [
    'worktree /tmp/a path', 'HEAD abc', 'branch refs/heads/feat/a', '',
    'worktree /tmp/b', 'HEAD def', 'detached', '',
  ].join('\0')
  assert.deepEqual(parseWorktreePorcelain(input), [
    { path: '/tmp/a path', head: 'abc', branch: 'refs/heads/feat/a', detached: false, prunable: null },
    { path: '/tmp/b', head: 'def', branch: null, detached: true, prunable: null },
  ])
  assert.deepEqual(parseWorktreePorcelain('worktree /tmp/legacy path\nHEAD abc\nbranch refs/heads/legacy\n\n'), [
    { path: '/tmp/legacy path', head: 'abc', branch: 'refs/heads/legacy', detached: false, prunable: null },
  ])
})

test('cleanup refuses every non-pruneable branch shape', () => {
  const base = {
    merged: true,
    openPr: false,
    requiredByOpenPr: false,
    worktreeDirty: false,
    localOid: 'abc',
    expectedHead: 'abc',
    sameRepository: true,
  }
  assert.equal(evaluateCleanup(base).pruneable, true)
  for (const change of [
    { merged: false },
    { openPr: true },
    { requiredByOpenPr: true },
    { worktreeDirty: true },
    { localOid: 'newer' },
    { sameRepository: false },
  ]) {
    assert.equal(evaluateCleanup({ ...base, ...change }).pruneable, false)
  }
})

test('merge method distinguishes enabled capability from blessed policy', () => {
  const capabilities = { squash: true, merge: true, rebase: false }
  assert.deepEqual(resolveMergeMethod(capabilities, ['squash']), { method: 'squash', source: 'repository-policy' })
  assert.equal(resolveMergeMethod(capabilities, []).status, 'clarification_required')
  assert.equal(resolveMergeMethod(capabilities, ['rebase']).status, 'blocked')
})

test('merge blocks a changed head before invoking mutation', async () => {
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'pr' && args[1] === 'view') {
      return { stdout: JSON.stringify({ number: 4, state: 'OPEN', headRefOid: 'new', isCrossRepository: false }) }
    }
    throw new Error('mutation should not run')
  }
  const result = await mergePullRequest({ pr: 4, expectedHead: 'old', method: 'squash', runner })
  assert.equal(result.status, 'head_changed')
  assert.equal(calls.length, 1)
})

test('merge reports queued/open separately from actually merged', async () => {
  let views = 0
  const runner = async (_command, args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      views += 1
      return { stdout: JSON.stringify(views === 1
        ? { number: 4, state: 'OPEN', headRefOid: 'abc', isCrossRepository: false }
        : { number: 4, state: 'OPEN', headRefOid: 'abc', mergedAt: null }) }
    }
    if (args[0] === 'pr' && args[1] === 'merge') return { stdout: '' }
    throw new Error(`unexpected: ${args.join(' ')}`)
  }
  const result = await mergePullRequest({ pr: 4, expectedHead: 'abc', method: 'squash', capabilities: { squash: true }, runner, pollAttempts: 1 })
  assert.equal(result.status, 'queued_or_open')
})

test('merge sends the selected method with the exact approved head', async () => {
  const calls = []
  let views = 0
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'pr' && args[1] === 'view') {
      views += 1
      return { stdout: JSON.stringify(views === 1
        ? { number: 4, state: 'OPEN', headRefOid: 'abc' }
        : { number: 4, state: 'MERGED', headRefOid: 'abc', mergedAt: '2026-08-06T00:00:00Z' }) }
    }
    if (args[0] === 'pr' && args[1] === 'merge') return { stdout: '' }
    throw new Error(`unexpected: ${args.join(' ')}`)
  }

  const result = await mergePullRequest({
    pr: 4, expectedHead: 'abc', method: 'squash', capabilities: { squash: true }, runner,
  })
  assert.equal(result.status, 'merged')
  assert.deepEqual(calls[1], ['gh', 'pr', 'merge', '4', '--squash', '--match-head-commit', 'abc'])
})

test('external-check environment omits common credentials', () => {
  const env = scrubEnvironment({
    PATH: '/bin', LANG: 'C', HOME: '/secret/home', GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', SSH_AUTH_SOCK: '/tmp/sock',
  })
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C', CI: '1' })
})

test('command capture reports output truncation instead of silently presenting a complete result', async () => {
  const result = await execRun('git', ['--version'], { outputLimit: 3 })
  assert.equal(result.stdout, 'git')
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stderrTruncated, false)
})

test('local checks require separate fork approval and execute at the exact detached head', async t => {
  const fixture = await createRepositoryFixture(t)
  const head = git(fixture.local, 'rev-parse', 'HEAD')
  const runner = async (command, args, options = {}) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return { code: 0, stdout: JSON.stringify({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: true }), stderr: '' }
    }
    if (command === 'git' && options.cwd) return execRun(command, args, options)
    return fixture.runner(command, args, options)
  }

  const blocked = await runCheck({ pr: 9, expectedHead: head, command: ['git', 'status', '--porcelain'], runner })
  assert.equal(blocked.status, 'approval_required')

  const checked = await runCheck({
    pr: 9, expectedHead: head, command: ['git', 'status', '--porcelain'], approveExternal: true, runner,
  })
  assert.equal(checked.status, 'passed')
  assert.equal(checked.head, head)
  assert.equal(checked.cleanup, 'removed')
})

test('default sync fast-forwards a clean checkout and preserves approved dirty work', async t => {
  const fixture = await createRepositoryFixture(t)
  await writeFile(join(fixture.seed, 'file.txt'), 'two\n')
  git(fixture.seed, 'add', 'file.txt')
  git(fixture.seed, 'commit', '-m', 'advance')
  git(fixture.seed, 'push', 'origin', 'main')

  const clean = await syncDefaultBranch({ runner: fixture.runner })
  assert.deepEqual({ status: clean.status, ahead: clean.ahead, behind: clean.behind }, { status: 'synced', ahead: 0, behind: 0 })
  assert.equal(readFileSync(join(fixture.local, 'file.txt'), 'utf8'), 'two\n')

  await writeFile(join(fixture.seed, 'remote.txt'), 'remote\n')
  git(fixture.seed, 'add', 'remote.txt')
  git(fixture.seed, 'commit', '-m', 'advance again')
  git(fixture.seed, 'push', 'origin', 'main')
  await writeFile(join(fixture.local, 'file.txt'), 'local dirty\n')
  git(fixture.local, 'add', 'file.txt')
  await writeFile(join(fixture.local, 'untracked.txt'), 'untracked\n')

  const proposed = await syncDefaultBranch({ runner: fixture.runner })
  assert.equal(proposed.status, 'approval_required')
  const applied = await syncDefaultBranch({ approvalToken: proposed.approvalToken, runner: fixture.runner })
  assert.equal(applied.status, 'synced')
  assert.equal(readFileSync(join(fixture.local, 'file.txt'), 'utf8'), 'local dirty\n')
  assert.equal(readFileSync(join(fixture.local, 'untracked.txt'), 'utf8'), 'untracked\n')
  assert.equal(git(fixture.local, 'diff', '--cached', '--name-only'), 'file.txt')
  assert.equal(git(fixture.local, 'stash', 'list'), '')

  await writeFile(join(fixture.seed, 'third.txt'), 'remote again\n')
  git(fixture.seed, 'add', 'third.txt')
  git(fixture.seed, 'commit', '-m', 'advance a third time')
  git(fixture.seed, 'push', 'origin', 'main')
  const unknownStatusRunner = async (command, args, options = {}) => {
    if (command === 'git' && args[0] === '-C' && args[2] === 'status') {
      return { code: 128, stdout: '', stderr: 'status unavailable' }
    }
    return fixture.runner(command, args, options)
  }
  const unknown = await syncDefaultBranch({ runner: unknownStatusRunner })
  assert.equal(unknown.status, 'blocked')
  assert.equal(unknown.blocker, 'default_worktree_status_unknown')
})

test('cleanup deletes only the exact merged PR branch with an OID lease', async t => {
  const fixture = await createRepositoryFixture(t)
  git(fixture.local, 'switch', '-c', 'feature')
  await writeFile(join(fixture.local, 'feature.txt'), 'feature\n')
  git(fixture.local, 'add', 'feature.txt')
  git(fixture.local, 'commit', '-m', 'feature')
  const head = git(fixture.local, 'rev-parse', 'HEAD')
  git(fixture.local, 'push', '-u', 'origin', 'feature')
  git(fixture.local, 'switch', 'main')

  let remoteProbeFails = true
  const runner = async (command, args, options = {}) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return { code: 0, stdout: JSON.stringify({
        number: 12, state: 'MERGED', mergedAt: '2026-08-06T00:00:00Z',
        headRefName: 'feature', headRefOid: head, isCrossRepository: false,
        headRepository: { nameWithOwner: 'owner/repo' },
      }), stderr: '' }
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { code: 0, stdout: '[]', stderr: '' }
    }
    if (command === 'git' && args[0] === 'ls-remote' && remoteProbeFails) {
      return { code: 2, stdout: '', stderr: 'remote unavailable' }
    }
    return fixture.runner(command, args, options)
  }

  const blocked = await cleanupPullRequest({ pr: 12, expectedHead: head, runner })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.blocker, 'remote_branch_state_unknown')
  assert.equal(git(fixture.local, 'rev-parse', 'refs/heads/feature'), head)

  remoteProbeFails = false
  const result = await cleanupPullRequest({ pr: 12, expectedHead: head, runner })
  assert.equal(result.status, 'cleaned')
  assert.throws(() => git(fixture.local, 'show-ref', '--verify', 'refs/heads/feature'))
  assert.equal(git(fixture.local, 'ls-remote', '--heads', 'origin', 'refs/heads/feature'), '')
})

test('installer copy mode carries the entire skill tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tidy-repo-install-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const dest = join(root, '.claude')
  await mkdir(dest)
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['bin/install-skills.js', '--dest', dest, '--copy'], {
    cwd: resolve('.'), encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  for (const path of [
    'SKILL.md', 'agents/openai.yaml', 'scripts/tidy-repo.mjs',
    'references/briefing-contract.md', 'references/safety-contract.md',
  ]) {
    assert.doesNotThrow(() => readFileSync(join(dest, 'skills/tidy-repo', path)))
  }
  const commands = await discoverSlashCommands({ home: root, cwd: join(root, 'workspace') })
  assert.equal(commands.find(command => command.name === 'tidy-repo')?.source, 'user-skill')
})
