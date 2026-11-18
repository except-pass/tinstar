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
afterEach(() => vi.useRealTimers())

function answer(status: number, body: unknown = null, headers = '') {
  const stdout = `HTTP/2.0 ${status} Example\n${headers}\r\n${body === null ? '' : JSON.stringify(body)}`
  exec.mockImplementationOnce((_binary, _args, _options, done) => {
    if (status >= 300) done(Object.assign(new Error('private CLI diagnostics'), { stdout }))
    else done(null, { stdout })
  })
}

it('sends an ETag on a repeat GET, reuses the cached body on 304 and expires hourly counts', async () => {
  const data = [{ title: 'quoted "title"\npayload: untrusted', body: 'λ' }]
  answer(200, { payload: data }, 'Etag: W/"abc"\n')
  expect(await github.githubJson(pulls)).toEqual(data)
  answer(304)
  expect(await github.githubJson(pulls)).toEqual(data)
  expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['gh', ['api', pulls, '--method', 'GET', '--include', '--jq', '{payload:(.)}']])
  expect(exec.mock.calls[1]?.[1].slice(-2)).toEqual(['--header', 'If-None-Match:W/"abc"'])
  expect(github.githubCliStats()).toEqual({ requests: 2, notModified: 1, blockedUntil: null })
  vi.setSystemTime(clock + 3_600_000)
  expect(github.githubCliStats()).toEqual({ requests: 0, notModified: 0, blockedUntil: null })
})

it('suppresses other GitHub GETs until a primary reset and resumes without a fallback request', async () => {
  const reset = clock + 120_000
  answer(403, { message: 'private error detail' }, `X-RateLimit-Remaining: 0\nX-RateLimit-Reset: ${reset / 1000}\n`)
  await expect(github.githubJson(pulls)).rejects.toThrow('GitHub REST rate limited until')
  vi.setSystemTime(reset - 1)
  await expect(github.githubCliJson(`${pulls}/2`, '{state}')).rejects.toThrow('GitHub REST rate limited until')
  expect(exec).toHaveBeenCalledTimes(1)
  expect(github.githubCliStats()).toEqual({ requests: 1, notModified: 0, blockedUntil: new Date(reset).toISOString() })
  vi.setSystemTime(reset)
  answer(200, { payload: { state: 'open' } })
  expect(await github.githubCliJson(`${pulls}/2`, '{state}')).toEqual({ state: 'open' })
  expect(github.githubCliStats()).toEqual({ requests: 2, notModified: 0, blockedUntil: null })
})

it.each([
  [429, 'Retry-After: 90\n', 'Try again later', 90_000],
  [403, '', 'You have exceeded a secondary rate limit', 60_000],
])('pauses after HTTP %s with rate-limit signals', async (status, headers, message, wait) => {
  answer(status, { message }, headers)
  await expect(github.githubJson(pulls)).rejects.toThrow(new Date(clock + wait).toISOString())
  expect(exec).toHaveBeenCalledTimes(1)
})

it('backs off ordinary errors per resource without holding other callers', async () => {
  answer(403, { message: 'private repository error' })
  await expect(github.githubJson(pulls)).rejects.toThrow('HTTP 403')
  await expect(github.githubJson(pulls)).rejects.toThrow('HTTP 403')
  answer(200, { payload: [] })
  expect(await github.githubJson(`${pulls}?page=2`)).toEqual([])
  vi.setSystemTime(clock + 30_000)
  answer(500)
  await expect(github.githubJson(pulls)).rejects.toThrow('HTTP 500')
  vi.setSystemTime(clock + 89_999)
  await expect(github.githubJson(pulls)).rejects.toThrow('HTTP 500')
  expect(exec).toHaveBeenCalledTimes(3)
  vi.setSystemTime(clock + 90_000)
  answer(200, { payload: [] })
  expect(await github.githubJson(pulls)).toEqual([])
})

it('falls back to gh-axi when gh is missing and decodes the legacy projection', async () => {
  const data = [{ title: 'quoted "title"\npayload: untrusted', body: 'λ' }]
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(Object.assign(new Error('missing gh'), { code: 'ENOENT' })))
  exec.mockImplementationOnce((_binary, _args, _options, done) => done(null, { stdout: `payload: ${Buffer.from(JSON.stringify(data)).toString('base64')}\n` }))
  expect(await github.githubJson(pulls)).toEqual(data)
  expect(exec.mock.calls[1]?.slice(0, 2)).toEqual(['gh-axi', ['api', 'GET', pulls, '--jq', '{payload:(.|tojson|@base64)}', '--full']])
  expect(github.githubCliStats().requests).toBe(1)
})

it('reports a missing binary without echoing credential-bearing stderr', async () => {
  exec.mockImplementation((_binary, _args, _options, done) => done(Object.assign(new Error('secret stderr'), { code: 'ENOENT' })))
  await expect(github.githubJson('/user')).rejects.toThrow('gh-axi is missing from the server PATH')
  expect(github.githubCliStats().requests).toBe(0)
})
