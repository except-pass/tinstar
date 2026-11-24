import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

const timeout = 15_000

export class DeliveryError extends Error {
  constructor(message, receiptId = null) {
    super(message)
    this.receiptId = receiptId
  }
}

export function mateDestination(config) {
  if (typeof config?.home !== 'string' || !isAbsolute(config.home)) {
    throw new DeliveryError('mate destination requires its absolute local home path')
  }
  return { home: config.home }
}

export function webhookDestination(config) {
  const url = typeof config?.url === 'string' && URL.parse(config.url)
  const loopback = url && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new DeliveryError('webhook destination requires an HTTPS URL without credentials, query or fragment (HTTP is allowed on loopback)')
  }
  return { url }
}

function inboxNote(home, requestId, body) {
  return new Promise((resolve, reject) => {
    // The launcher owns the broker and webhook secrets. Pass only the runtime
    // context needed by the installed local First Mate inbox command.
    const { HOME, PATH, USER, LOGNAME, SHELL, LANG, TMPDIR } = process.env
    const child = spawn(join(home, 'bin', 'fm-inbox.sh'), ['note', '--request-id', requestId, '--json', '-'], {
      env: { HOME, PATH, USER, LOGNAME, SHELL, LANG, TMPDIR, FM_HOME: home },
      stdio: ['pipe', 'pipe', 'ignore'],
      signal: AbortSignal.timeout(timeout),
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.on('error', () => reject(new DeliveryError('cannot run the local First Mate inbox command')))
    child.on('close', code => resolve({ code, stdout }))
    child.stdin.on('error', () => { /* close reports child failure */ })
    child.stdin.end(body)
  })
}

export async function deliverMate({ home }, event, requestId) {
  if (event.schema !== 'tinstar.inbox.v1' || typeof event.body !== 'string' || !event.body.trim() ||
      event.body.includes('\0')) {
    throw new DeliveryError('inbox event must carry a tinstar.inbox.v1 text note')
  }
  const { code, stdout } = await inboxNote(home, requestId, event.body)
  if (code !== 0 && code !== 3) throw new DeliveryError('First Mate inbox command failed')
  let receipt
  try {
    receipt = JSON.parse(stdout)
  } catch {
    throw new DeliveryError('First Mate returned an unreadable inbox receipt')
  }
  if (receipt?.schema !== 'fm-inbox-note.v1' || receipt.saved !== true || receipt.request_id !== requestId ||
      typeof receipt.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(receipt.id)) {
    throw new DeliveryError('First Mate did not confirm persistence of this request')
  }
  if (code === 3 || (receipt.announced !== true && receipt.acknowledged !== true)) {
    // Replaying the same request ID repairs a missing wake without saving a new note.
    throw new DeliveryError('First Mate saved the note but could not announce it', receipt.id)
  }
  return receipt.id
}

export async function deliverWebhook({ url }, event, requestId, token) {
  // Keep the default forwarding envelope small. Native webhook evidence,
  // note bodies and provider-specific fields stay inside the engineering bus.
  const payload = { schema: 'tinstar.webhook.v1' }
  for (const key of ['event_id', 'topic', 'event_type', 'kind', 'observed_at', 'occurred_at']) {
    if (typeof event[key] === 'string') payload[key] = event[key]
  }
  if (typeof event.subject?.type === 'string' && typeof event.subject.id === 'string') {
    payload.subject = { type: event.subject.type, id: event.subject.id }
  }
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new DeliveryError('webhook request failed')
  }
  await response.body?.cancel().catch(() => { /* status is already available */ })
  if (!response.ok) throw new DeliveryError(`webhook returned HTTP ${response.status}`)
  return requestId
}
