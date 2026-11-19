import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { liveActionsEnabled, liveReaderJson } from '../actions/liveClient'
import { GithubRestBudget, GithubResponseError, isGithubRateLimit, isGithubResponseError, type GithubRestHeaders, type GithubRestResponse } from './restBudget'

const exec = promisify(execFile)
const budget = new GithubRestBudget('cli')
const options = { timeout: 12_000, maxBuffer: 4 * 1024 * 1024 }

function includedResponse(stdout: string): GithubRestResponse | undefined {
  const end = /\r?\n\r?\n/.exec(stdout)
  if (!end) return
  const [statusLine, ...lines] = stdout.slice(0, end.index).split(/\r?\n/)
  const status = Number(/^HTTP\/\S+ (\d{3})(?: |$)/.exec(statusLine ?? '')?.[1])
  if (!status) return
  const headers = new Map(lines.map(line => {
    const separator = line.indexOf(':')
    return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()]
  }))
  const body = stdout.slice(end.index + end[0].length)
  let data: unknown = null
  if (body.trim()) {
    try { data = JSON.parse(body) }
    catch { data = null }
  }
  return { status, data, headers: { etag: headers.get('etag'), remaining: headers.get('x-ratelimit-remaining'),
    reset: headers.get('x-ratelimit-reset'), retryAfter: headers.get('retry-after') } }
}

type CliError = NodeJS.ErrnoException & { stdout?: string; stderr?: string }
type CliLimits = typeof options

async function includedRequest(binary: string, path: string, projection: string, etag: string | undefined, limits: CliLimits, received: (response: GithubRestHeaders) => void) {
  const args = ['api', path, '--method', 'GET', '--include', '--jq', `{payload:(${projection})}`]
  if (etag) args.push('--header', `If-None-Match:${etag}`)
  let stdout: string
  let failure: CliError | undefined
  try { ({ stdout } = await exec(binary, args, limits)) }
  catch (error) {
    // gh exits nonzero for 304, 403 and 429, but keeps HTTP metadata on stdout.
    failure = error as CliError
    if (!failure.stdout) throw error
    stdout = failure.stdout
  }
  const response = includedResponse(stdout)
  if (response) received(response)
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && response && response.status >= 200 && response.status < 300) throw new GithubResponseError()
  if (failure && (!response || response.status < 300)) throw failure
  if (!response) throw new Error('GitHub response metadata unavailable')
  return response
}

async function legacyRequest(args: string[], decode: (stdout: string) => unknown, commandOptions: CliLimits): Promise<GithubRestResponse> {
  try {
    const { stdout } = await exec('gh-axi', args, commandOptions)
    return { status: 200, data: decode(stdout) }
  } catch (error) {
    if (isGithubResponseError(error)) throw error
    const failure = error as CliError
    const diagnostics = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    if (/^code: RATE_LIMITED\r?$/m.test(diagnostics) || /\bHTTP 429\b/.test(diagnostics)) {
      const retryAfter = /secondary rate limit/i.test(diagnostics) ? '60' : '3600'
      return { status: 429, data: null, headers: { retryAfter } }
    }
    if (failure.code === 'ENOENT') {
      throw Object.assign(new Error('GitHub reader unavailable: gh-axi is missing from the server PATH.'), { code: 'ENOENT' })
    }
    throw new Error('GitHub request failed: check CLI authentication, repository access and rate budget.')
  }
}

async function cliGet(binary: string, path: string, projection: string, etag: string | undefined, limits: CliLimits, allowFallback: boolean) {
  try {
    const response = await budget.send(received => includedRequest(binary, path, projection, etag, limits, received))
    if (response.status >= 200 && response.status < 300) {
      if (!response.data || typeof response.data !== 'object' || !('payload' in response.data)) throw new GithubResponseError()
      response.data = response.data.payload
    }
    return response
  }
  catch (error) {
    if (!allowFallback || (error as CliError).code !== 'ENOENT') {
      if (isGithubRateLimit(error) || isGithubResponseError(error)) throw error
      throw new Error('GitHub request failed: check CLI authentication, repository access and rate budget.')
    }
    return budget.send(() => legacyRequest(['api', 'GET', path, '--jq', `{payload:(${projection}|tojson|@base64)}`, '--full'], stdout => {
      const value = /^payload: (.+)\s*$/.exec(stdout.trim())?.[1]
      const payload: unknown = value?.startsWith('"') ? JSON.parse(value) : value
      if (typeof payload !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(payload)) throw new GithubResponseError()
      try { return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) }
      catch { throw new GithubResponseError() }
    }, limits))
  }
}

export function githubCliJson(path: string, projection = '.', limits: CliLimits = options, allowFallback = true): Promise<unknown> {
  const binary = allowFallback ? process.env.GH_BIN || 'gh' : 'gh'
  return budget.get(JSON.stringify([binary, path, projection, limits.timeout, limits.maxBuffer, allowFallback]), etag =>
    cliGet(binary, path, projection, etag, limits, allowFallback))
}

export async function githubCliPost(path: string, input: string, limits: CliLimits): Promise<unknown> {
  const response = await budget.send(() => legacyRequest(['api', 'POST', path, '--jq', '{payload: (.|tojson)}', '--full', '--input', input], stdout => {
    const value: unknown = JSON.parse(stdout.trim().replace(/^payload: /, ''))
    return typeof value === 'string' ? JSON.parse(value) : value
  }, limits))
  return response.data
}

export async function githubCliCreateRelease(args: string[]): Promise<void> {
  await budget.send(() => legacyRequest(['release', 'create', ...args], () => null, { timeout: 30_000, maxBuffer: 256 * 1024 }))
}

/** Live reads stay behind broker custody. */
export async function githubJson(path: string, projection = '.'): Promise<unknown> {
  return liveActionsEnabled() ? liveReaderJson(path, projection) : githubCliJson(path, projection)
}
