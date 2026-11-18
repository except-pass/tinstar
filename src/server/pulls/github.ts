import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { liveActionsEnabled, liveReaderJson } from '../actions/liveClient'
import { GithubRestBudget, type GithubRestResponse } from './restBudget'

const exec = promisify(execFile)
const budget = new GithubRestBudget()
const options = { timeout: 12_000, maxBuffer: 4 * 1024 * 1024 }
export const githubCliStats = () => budget.stats()

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
    catch {
      if (status >= 200 && status < 300) throw new Error('Unsupported GitHub response')
    }
  }
  return { status, data, headers: { etag: headers.get('etag'), remaining: headers.get('x-ratelimit-remaining'),
    reset: headers.get('x-ratelimit-reset'), retryAfter: headers.get('retry-after') } }
}

async function includedGet(path: string, projection: string, etag?: string) {
  const args = ['api', path, '--method', 'GET', '--include', '--jq', `{payload:(${projection})}`]
  if (etag) args.push('--header', `If-None-Match:${etag}`)
  let stdout: string
  try { ({ stdout } = await exec('gh', args, options)) }
  catch (error) {
    // gh exits nonzero for 304, 403 and 429, but keeps HTTP metadata on stdout.
    const failure = error as NodeJS.ErrnoException & { stdout?: string }
    if (!failure.stdout) throw error
    stdout = failure.stdout
  }
  const response = includedResponse(stdout)
  if (!response) throw new Error('GitHub response metadata unavailable')
  if (response.status >= 200 && response.status < 300) {
    if (!response.data || typeof response.data !== 'object' || !('payload' in response.data)) throw new Error('Unsupported GitHub response')
    response.data = response.data.payload
  }
  return response
}

export function githubCliJson(path: string, projection = '.'): Promise<unknown> {
  return budget.get(JSON.stringify([path, projection]), async etag => {
    try { return await budget.send(() => includedGet(path, projection, etag)) }
    catch (error) {
      // A confirmed throttle must never reach the legacy transport.
      budget.assertAvailable()
      try {
        return await budget.send(async () => {
          const { stdout } = await exec('gh-axi', ['api', 'GET', path, '--jq', `{payload:(${projection}|tojson|@base64)}`, '--full'], options)
          const value = /^payload: (.+)\s*$/.exec(stdout.trim())?.[1]
          const payload: unknown = value?.startsWith('"') ? JSON.parse(value) : value
          if (typeof payload !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(payload)) throw new Error('Unsupported GitHub response')
          return { status: 200, data: JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) }
        })
      } catch (fallbackError) {
        budget.assertAvailable()
        // CLI diagnostics may contain private request data. Preserve only ENOENT.
        if ((fallbackError as NodeJS.ErrnoException).code === 'ENOENT') {
          throw Object.assign(new Error('GitHub reader unavailable: gh-axi is missing from the server PATH.'), { code: 'ENOENT' })
        }
        throw new Error('GitHub read failed: check CLI authentication, repository access and rate budget.')
      }
    }
  })
}

/** Live reads stay behind broker custody. */
export async function githubJson(path: string, projection = '.'): Promise<unknown> {
  return liveActionsEnabled() ? liveReaderJson(path, projection) : githubCliJson(path, projection)
}
