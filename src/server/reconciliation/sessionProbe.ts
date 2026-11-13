import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { leaseCaller } from './cardLeases'

const maxEntries = 128
const maxNames = 64
const names = (value: object) => Object.keys(value).sort().slice(0, maxNames).map(key => key.slice(0, 128))

/** Diagnostic names only: never persist metadata/header values, arguments or tokens.
 * Separate boundary files show what the facade received versus the backend.
 * A failed diagnostic write must not break a read-only continuity experiment. */
export function recordProbeNames(root: string, boundary: 'facade' | 'backend', headers: IncomingHttpHeaders, meta?: Record<string, unknown>) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const path = join(root, `session-probe-${boundary}.jsonl`)
    let previous: string[] = []
    try { previous = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).slice(-(maxEntries - 1)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const entry = JSON.stringify({ header_names: names(headers), meta_keys: names(meta ?? {}) })
    writeFileSync(path, [...previous, entry].join('\n') + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
    return true
  } catch { return false }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Deliberately process-local and bounded. This probe proves explicit argument
 * continuity only; it is neither a durable session registry nor a card lease. */
export class SessionProbe {
  private issued = new Map<string, string>()
  constructor(private root: string) {}

  call(actor: string, headers: IncomingHttpHeaders, meta?: Record<string, unknown>, token?: string) {
    const logRecorded = recordProbeNames(this.root, 'backend', headers, meta)
    // Bind to the existing authenticated caller boundary, including credential
    // rotation. Client metadata and browser session IDs grant no authority.
    const caller = leaseCaller(actor, headers)
    if (token !== undefined) {
      const matches = this.issued.get(digest(token)) === caller
      return { outcome: matches ? 'recognized' : 'unknown-token', matches_known_token: matches, log_recorded: logRecorded,
        next_action: matches ? 'Explicit token continuity confirmed for this call. Keep the token in tool arguments only.' : 'No matching token for this authenticated caller in this backend process. Call without a token to start a new probe.' }
    }
    const sessionToken = randomBytes(32).toString('base64url')
    if (this.issued.size >= 256) this.issued.delete(this.issued.keys().next().value!)
    this.issued.set(digest(sessionToken), caller)
    return { outcome: 'issued', session_token: sessionToken, log_recorded: logRecorded,
      next_action: 'Call session_probe again with this session_token, then repeat in a later turn. Keep it in tool arguments; do not print it, save it to a card, or put it in a URL. This process-local probe does not establish automatic conversation identity or reserve work.' }
  }
}
