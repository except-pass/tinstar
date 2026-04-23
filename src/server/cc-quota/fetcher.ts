import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CcQuotaFetchError, type FetchErrorCode, type RawUsage } from './types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

function throwAs(code: FetchErrorCode, message: string): never {
  throw new CcQuotaFetchError({ code, message })
}

function readAccessToken(): string {
  const path = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(path)) throwAs('no_creds', `no credentials at ${path}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throwAs('no_creds', `credentials not JSON: ${(err as Error).message}`)
  }
  const tok = (parsed as { claudeAiOauth?: { accessToken?: unknown } } | null)?.claudeAiOauth?.accessToken
  if (typeof tok !== 'string' || tok.length === 0) {
    throwAs('no_creds', 'claudeAiOauth.accessToken missing')
  }
  return tok
}

export async function fetchCcQuota(): Promise<RawUsage> {
  const token = readAccessToken()

  let res: Response
  try {
    res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}` } })
  } catch (err) {
    throwAs('network', (err as Error).message)
  }

  if (res.status === 401) throwAs('expired_token', 'oauth token expired')
  if (res.status >= 500) throwAs('http_5xx', `upstream ${res.status}`)
  if (!res.ok) throwAs('http_4xx', `upstream ${res.status}`)

  try {
    return (await res.json()) as RawUsage
  } catch (err) {
    throwAs('http_4xx', `malformed JSON: ${(err as Error).message}`)
  }
}
