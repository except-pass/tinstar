import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { INTENT_SCHEMA, parseIntentEnvelope, type IntentEnvelope } from '../../../v6/contract/intent'
import { isRecord } from '../../../v6/contract/result'
import { requestIdAllowed } from '../../../v6/objective/model'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface InboxRunner {
  exec(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>
}

export interface IntentSubmission {
  requestId: string
  noteId: string | null
  disposition: 'queued' | 'saved-unannounced' | 'not-receivable' | 'failed'
  applied: false
  announced: boolean | null
  canReceive: boolean | 'unknown' | null
  exitCode: number | null
  detail: string
  noteOutcome: string | null
}

export interface ObjectiveInboxOptions {
  home?: string | null
  binDir?: string | null
  runner?: InboxRunner
}

const REFUSED_KEYS = new Set(['command', 'shell', 'argv', 'tmux'])

export const defaultInboxRunner: InboxRunner = {
  exec(script, args, env) {
    return new Promise(resolve => {
      execFile(script, args, { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = !err ? 0 : typeof err.code === 'number' ? err.code : null
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
  },
}

export function resolveFmHome(explicit?: string | null): string | null {
  const raw = explicit?.trim() || process.env.TINSTAR_V6_FM_HOME?.trim()
  return raw || null
}

export function resolveFmBinDir(explicit?: string | null): string | null {
  const raw = explicit?.trim() || process.env.FM_V6_BIN?.trim() || process.env.TINSTAR_V6_FM_BIN?.trim()
  if (!raw) return null
  return raw.endsWith('.sh') ? dirname(raw) : raw
}

function failed(requestId: string, detail: string, exitCode: number | null = null): IntentSubmission {
  return {
    requestId,
    noteId: null,
    disposition: 'failed',
    applied: false,
    announced: null,
    canReceive: null,
    exitCode,
    detail,
    noteOutcome: null,
  }
}

function refusedKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = refusedKey(item)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (REFUSED_KEYS.has(key)) return key
    const found = refusedKey(value[key])
    if (found) return found
  }
  return null
}

/** Force FM_HOME for the child. Drop TMUX so a live session cannot leak in. */
export function inboxChildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === 'FM_HOME' || key === 'FM_STATE_OVERRIDE' || key === 'FM_DATA_OVERRIDE' || key === 'FM_TEST_HOME' || key === 'TMUX') {
      continue
    }
    if (key.startsWith('FM_') && key.endsWith('_OVERRIDE')) continue
    env[key] = value
  }
  env.FM_HOME = home
  delete env.TMUX
  return env
}

function parseNoteStdout(stdout: string): { id: string | null; outcome: string | null; announced: boolean | null; saved: boolean } | null {
  const line = stdout.split('\n').find(row => row.includes('"schema"')) ?? stdout.trim()
  try {
    const raw = JSON.parse(line) as unknown
    if (!isRecord(raw) || raw.schema !== 'fm-inbox-note.v1') return null
    return {
      id: typeof raw.id === 'string' ? raw.id : null,
      outcome: typeof raw.outcome === 'string' ? raw.outcome : null,
      announced: typeof raw.announced === 'boolean' ? raw.announced : null,
      saved: raw.saved === true,
    }
  } catch {
    return null
  }
}

async function readReady(runner: InboxRunner, script: string, env: NodeJS.ProcessEnv): Promise<{ canReceive: boolean | 'unknown'; detail: string }> {
  const result = await runner.exec(script, ['ready'], env)
  if (result.code !== 0) return { canReceive: 'unknown', detail: result.stderr.trim() || 'ready failed' }
  try {
    const raw = JSON.parse(result.stdout) as unknown
    if (!isRecord(raw) || raw.schema !== 'fm-primary-ready.v1') {
      return { canReceive: 'unknown', detail: 'ready payload was not fm-primary-ready.v1' }
    }
    if (raw.can_receive === true) return { canReceive: true, detail: '' }
    if (raw.can_receive === false) return { canReceive: false, detail: 'primary cannot receive' }
    return { canReceive: 'unknown', detail: 'can_receive is unknown' }
  } catch {
    return { canReceive: 'unknown', detail: 'ready payload was not JSON' }
  }
}

/**
 * Send one intent as `fm-inbox.sh note --request-id --json`.
 * The argv list is fixed. This function does not start a worker.
 */
export async function submitIntent(raw: unknown, opts: ObjectiveInboxOptions = {}): Promise<IntentSubmission> {
  const requestHint = isRecord(raw) && typeof raw.requestId === 'string' ? raw.requestId : ''
  if (refusedKey(raw)) return failed(requestHint, 'command, shell, and tmux fields are not accepted')
  const parsed = parseIntentEnvelope(raw)
  if (!parsed.ok) return failed(requestHint, parsed.diagnostic)
  const envelope: IntentEnvelope = parsed.value
  if (envelope.schema !== INTENT_SCHEMA) return failed(envelope.requestId, 'schema is not an intent')
  if (!requestIdAllowed(envelope.requestId)) return failed(envelope.requestId, 'requestId is not a valid inbox request id')

  const home = resolveFmHome(opts.home)
  const binDir = resolveFmBinDir(opts.binDir)
  if (!home || !binDir) return failed(envelope.requestId, 'First Mate home is not configured')
  const script = join(binDir, 'fm-inbox.sh')
  const runner = opts.runner ?? defaultInboxRunner
  if (!opts.runner && !existsSync(script)) return failed(envelope.requestId, 'First Mate inbox is not configured')

  const env = inboxChildEnv(home)
  const note = await runner.exec(script, [
    'note',
    '--request-id',
    envelope.requestId,
    '--json',
    '--',
    JSON.stringify(envelope),
  ], env)
  const payload = parseNoteStdout(note.stdout)
  if (note.code !== 0 && note.code !== 3) {
    return failed(
      envelope.requestId,
      note.stderr.trim() || (note.code === null ? 'inbox note could not be started' : 'nothing saved'),
      note.code,
    )
  }
  if (!payload?.saved || !payload.id) {
    return failed(envelope.requestId, note.stderr.trim() || 'nothing saved', note.code)
  }

  const ready = await readReady(runner, script, env)
  let disposition: IntentSubmission['disposition']
  if (ready.canReceive !== true) disposition = 'not-receivable'
  else if (note.code === 3 || payload.announced === false) disposition = 'saved-unannounced'
  else disposition = 'queued'

  const detail = disposition === 'queued'
    ? (payload.outcome === 'replay' ? 'Replayed the original note. Not applied.' : 'Queued. Not applied.')
    : disposition === 'saved-unannounced'
      ? 'Saved, not announced.'
      : ready.detail || 'Not receivable.'

  return {
    requestId: envelope.requestId,
    noteId: payload.id,
    disposition,
    applied: false,
    announced: payload.announced,
    canReceive: ready.canReceive,
    exitCode: note.code,
    detail,
    noteOutcome: payload.outcome,
  }
}
