import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { liveActionsEnabled, liveReaderJson } from '../actions/liveClient'
const exec = promisify(execFile)

/** gh-axi is the existing credential/forge boundary. Encode structured projections
 * in one scalar so multiline PR prose cannot be confused with the TOON envelope. */
export async function githubJson(path: string, projection = '.') : Promise<unknown> {
  if (liveActionsEnabled()) return liveReaderJson(path, projection)
  try {
    const { stdout } = await exec('gh-axi', ['api', 'GET', path, '--jq', `{payload:(${projection}|tojson|@base64)}`, '--full'], { timeout: 12_000, maxBuffer: 4 * 1024 * 1024 })
    const value = /^payload: (.+)\s*$/.exec(stdout.trim())?.[1]
    const payload: unknown = value?.startsWith('"') ? JSON.parse(value) : value
    if (typeof payload !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(payload)) throw new Error('Unsupported GitHub response')
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch (error) {
    // Never forward CLI stderr, which can contain private request data or auth diagnostics.
    throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'GitHub reader unavailable: gh-axi is missing from the server PATH.'
      : 'GitHub read failed: check gh-axi authentication, repository access and rate budget.')
  }
}
