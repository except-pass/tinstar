import { loadJq } from 'jq-wasm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))

const pulls = '/repos/owner/repo/pulls'
const clock = Date.parse('2026-06-01T00:00:00Z')
let github: typeof import('../github')
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(clock)
  github = await import('../github')
  exec.mockReset()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

function answer(status: number, body: unknown = null, headers = '') {
  const stdout = `HTTP/2.0 ${status} Example\n${headers}\r\n${body === null ? '' : JSON.stringify(body)}`
  exec.mockImplementationOnce((_binary, _args, _options, done) => {
    if (status >= 300) done(Object.assign(new Error('private CLI diagnostics'), { stdout }))
    else done(null, { stdout })
  })
}

it('projects titles only for linked rows in the CLI release list', async () => {
  vi.stubEnv('TINSTAR_ACTIONS_LIVE', '')
  const jq = await loadJq()
  const { readReleasePullPage } = await import('../releasePullPage')
  const updatedAt = '2026-06-01T00:00:00Z'
  const linked = { number: 1, title: 'A linked title', state: 'open', merged: null, merged_at: null,
    closed_at: null, updated_at: updatedAt, merge_commit_sha: null, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } }
  const input = [{ ...linked, body: 'private body', head: { ...linked.head, label: 'private label' } },
    { ...linked, number: 2, title: 'An unlinked title' }]
  exec.mockImplementationOnce((_binary, args: string[], _options, done) => {
    const projection = args[args.indexOf('--jq') + 1]!
    const result = jq.raw(JSON.stringify(input), projection)
    if (result.exitCode !== 0) done(new Error(result.stderr))
    else done(null, { stdout: `HTTP/2.0 200 OK\r\n\r\n${result.stdout}` })
  })
  await expect(readReleasePullPage(`${pulls}?state=all&sort=updated&direction=desc&per_page=100&page=1`, [1]))
    .resolves.toEqual({ rows: [linked], count: 2, oldestUpdatedAt: updatedAt })
})

it('reports the originating timestamp to a coalesced CLI caller', async () => {
  let complete!: (error: null, response: { stdout: string }) => void
  exec.mockImplementationOnce((_binary, _args, _options, done) => { complete = done })
  const first = github.githubCliJson(pulls)
  vi.setSystemTime(clock + 8_000)
  const started = vi.fn()
  const joined = github.githubCliJson(pulls, '.', undefined, true, started)
  complete(null, { stdout: 'HTTP/2.0 200 OK\r\n\r\n{"payload":[]}' })
  expect(await Promise.all([first, joined])).toEqual([[], []])
  expect(started.mock.calls).toEqual([[clock]])
  expect(exec).toHaveBeenCalledTimes(1)
})

it('sends an ETag on a repeat GET, reuses the cached body on 304 and logs after a full hour', async () => {
  const data = [{ title: 'quoted "title"\npayload: untrusted', body: 'λ' }]
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  answer(200, { payload: data }, 'Etag: W/"abc"\n')
  expect(await github.githubJson(pulls)).toEqual(data)
  answer(304)
  expect(await github.githubJson(pulls)).toEqual(data)
  expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['gh', ['api', pulls, '--method', 'GET', '--include', '--jq', '{payload:(.)}']])
  expect(exec.mock.calls[1]?.[1].slice(-2)).toEqual(['--header', 'If-None-Match:W/"abc"'])
  await vi.advanceTimersByTimeAsync(3_599_999)
  expect(log).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('GitHub REST hourly (cli) requests=2 notModified=1')
})

it('suppresses other GitHub GETs until a primary reset and resumes without a fallback request', async () => {
  const reset = clock + 120_000
  answer(403, { message: 'private error detail' }, `X-RateLimit-Remaining: 0\nX-RateLimit-Reset: ${reset / 1000}\n`)
  await expect(github.githubJson(pulls)).rejects.toThrow('GitHub REST rate limited')
  vi.setSystemTime(reset - 1)
  await expect(github.githubCliJson(`${pulls}/2`, '{state}')).rejects.toThrow('GitHub REST rate limited')
  expect(exec).toHaveBeenCalledTimes(1)
  vi.setSystemTime(reset)
  answer(200, { payload: { state: 'open' } })
  expect(await github.githubCliJson(`${pulls}/2`, '{state}')).toEqual({ state: 'open' })
})

it.each([
  [429, 'Retry-After: 90\n', 'Try again later', 90_000],
  [403, '', 'You have exceeded a secondary rate limit', 60_000],
])('pauses after HTTP %s with rate-limit signals', async (status, headers, message, wait) => {
  answer(status, { message }, headers)
  await expect(github.githubJson(pulls)).rejects.toThrow(/^GitHub REST rate limited$/)
  vi.setSystemTime(clock + wait - 1)
  await expect(github.githubJson(pulls)).rejects.toThrow(/^GitHub REST rate limited$/)
  expect(exec).toHaveBeenCalledTimes(1)
  vi.setSystemTime(clock + wait)
  answer(200, { payload: [] })
  await expect(github.githubJson(pulls)).resolves.toEqual([])
})

it('allows the next read of a resource after an ordinary failure', async () => {
  answer(403, { message: 'private repository error' })
  await expect(github.githubJson(pulls)).rejects.toThrow('HTTP 403')
  answer(500)
  await expect(github.githubJson(pulls)).rejects.toThrow('HTTP 500')
  answer(200, { payload: [] })
  expect(await github.githubJson(pulls)).toEqual([])
  expect(exec).toHaveBeenCalledTimes(3)
})

it('keeps timeout and decoding failures from sending a second request', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  exec.mockImplementationOnce((_binary, _args, _options, done) => setTimeout(() => done(new Error('private timeout diagnostic')), 3_600_001))
  const timedOut = expect(github.githubJson(pulls)).rejects.toThrow('GitHub request failed')
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(log).toHaveBeenCalledWith('GitHub REST hourly (cli) requests=0 notModified=0')
  await vi.advanceTimersByTimeAsync(1)
  await timedOut
  answer(200, { unexpected: [] })
  await expect(github.githubJson(pulls)).rejects.toThrow('GitHub request failed')
  expect(exec.mock.calls.map(call => call[0])).toEqual(['gh', 'gh'])
})

it('shares a hold from the legacy transport with subsequent CLI requests', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('missing gh'), { code: 'ENOENT' })))
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('private CLI diagnostics'), { stdout: 'error: GitHub API rate limit exceeded\ncode: RATE_LIMITED\n' })))
  await expect(github.githubJson(pulls)).rejects.toThrow('GitHub REST rate limited')
  await expect(github.githubCliJson('/repos/owner/repo/actions/runs/5')).rejects.toThrow('GitHub REST rate limited')
  await expect(github.githubCliPost('/repos/owner/repo/actions/workflows/smoke.yml/dispatches', 'input.json', { timeout: 15_000, maxBuffer: 256 * 1024 })).rejects.toThrow('GitHub REST rate limited')
  expect(exec).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('GitHub REST hourly (cli) requests=1 notModified=0')
})

it('falls back to gh-axi when gh is missing and decodes the legacy projection', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const data = [{ title: 'quoted "title"\npayload: untrusted', body: 'λ' }]
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('missing gh'), { code: 'ENOENT' })))
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(null, { stdout: `payload: ${Buffer.from(JSON.stringify(data)).toString('base64')}\n` }))
  const limits = { timeout: 5_000, maxBuffer: 64 * 1024 }
  expect(await github.githubCliJson(pulls, '.', limits)).toEqual(data)
  expect(exec.mock.calls.map(call => call[2])).toEqual([limits, limits])
  expect(exec.mock.calls[1]?.slice(0, 2)).toEqual(['gh-axi', ['api', 'GET', pulls, '--jq', '{payload:(.|tojson|@base64)}', '--full']])
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(log).toHaveBeenCalledWith('GitHub REST hourly (cli) requests=1 notModified=0')
})

it('reports a missing binary without echoing credential-bearing stderr', async () => {
  exec.mockImplementation((_binary, _args, _options, done) => done(Object.assign(new Error('secret stderr'), { code: 'ENOENT' })))
  await expect(github.githubJson('/user')).rejects.toThrow('gh-axi is missing from the server PATH')
})

it('does not fall back for a native-only read when gh is unavailable', async () => {
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('missing gh'), { code: 'ENOENT' })))
  await expect(github.githubCliJson(pulls, '.', { timeout: 8_000, maxBuffer: 1024 * 1024 }, false)).rejects.toThrow('GitHub request failed')
  expect(exec).toHaveBeenCalledTimes(1)
})

it('refuses a legacy 304 diagnostic even with a cached response', async () => {
  answer(200, { payload: [] }, 'Etag: "cached"\n')
  await expect(github.githubCliJson(pulls)).resolves.toEqual([])
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('missing gh'), { code: 'ENOENT' })))
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('legacy failure'), { stderr: 'HTTP 304' })))
  await expect(github.githubCliJson(pulls)).rejects.toThrow('GitHub request failed')
})

it('applies the header hold while the body is pending and retains it after interruption', async () => {
  const { GithubRestBudget } = await import('../restBudget')
  const budget = new GithubRestBudget('test')
  const interruption = new Error('body interrupted')
  let interrupt!: (error: Error) => void
  const pending = budget.send(received => {
    received({ status: 429, headers: { retryAfter: '120' } })
    return new Promise((_resolve, reject) => { interrupt = reject })
  })
  const next = vi.fn(async () => ({ status: 200, data: null }))
  await expect(budget.send(next)).rejects.toThrow('GitHub REST rate limited')
  interrupt(interruption)
  await expect(pending).rejects.toThrow('GitHub REST rate limited')
  vi.setSystemTime(clock + 119_999)
  await expect(budget.send(next)).rejects.toThrow('GitHub REST rate limited')
  expect(next).not.toHaveBeenCalled()
  vi.setSystemTime(clock + 120_000)
  await expect(budget.send(next)).resolves.toMatchObject({ status: 200 })
})

it('honors GH_BIN for legacy-backed reads and uses PATH gh for native-only reads', async () => {
  vi.stubEnv('GH_BIN', '/configured/gh')
  answer(200, { payload: ['configured'] }, 'Etag: "configured"\n')
  await expect(github.githubJson(pulls)).resolves.toEqual(['configured'])
  answer(200, { payload: ['path'] })
  await expect(github.githubCliJson(pulls, '.', undefined, false)).resolves.toEqual(['path'])
  expect(exec.mock.calls.map(call => call[0])).toEqual(['/configured/gh', 'gh'])
})
