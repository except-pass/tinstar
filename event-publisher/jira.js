import { createHmac, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

const host = '127.0.0.1'
const port = 18573
const webhookPath = '/webhooks/jira'
const bodyLimit = 1024 * 1024
const previewLimit = 4096
const issueKey = /^[A-Z][A-Z0-9_]{0,99}-[1-9]\d{0,29}$/
const nativeIdentifier = /^[a-zA-Z0-9:_-]{1,160}$/
const customField = /^customfield_[1-9]\d*$/
const builtInFields = new Map([
  ['summary', 'summary'], ['description', 'description'], ['status', 'status'],
  ['issuelinks', 'links'], ['Link', 'links'],
])
const projectFields = new Set(['owner', 'decisions', 'blockerType', 'blockerTarget', 'blockerCondition'])
const decoder = new TextDecoder('utf-8', { fatal: true })
const has = (value, key) => value != null && Object.hasOwn(value, key)
const nativeId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,29}$/.test(String(value)) ? String(value) : undefined
}
const tokenLike = /\b(?:ATATT|ATCTT|ntn_|secret_|sk-|github_pat_|gh[pousr]_)[a-zA-Z0-9_.~-]{16,}\b/g

export class JiraWebhookConfigurationError extends Error {}

export function jiraConfig(raw) {
  const { site, cloudId, projectId, fields } = raw ?? {}
  if (typeof site !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/.test(site) ||
      typeof cloudId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(cloudId) ||
      !nativeId(projectId)) {
    throw new JiraWebhookConfigurationError('Jira configuration needs a Cloud site URL, cloud ID, immutable project ID')
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      Object.keys(fields).length !== projectFields.size ||
      Object.entries(fields).some(([key, id]) => !projectFields.has(key) || typeof id !== 'string' || !customField.test(id)) ||
      new Set(Object.values(fields)).size !== Object.keys(fields).length) {
    throw new JiraWebhookConfigurationError('Jira requires all five distinct native custom field IDs')
  }
  const normalizedCloud = cloudId.toLowerCase()
  return {
    fields,
    source: {
      source_id: `jira:cloud:${normalizedCloud}:project:${projectId}`, provider: 'jira', cloud_id: normalizedCloud,
      site, project_id: String(projectId), home_path: null, type: 'ticket', coverage: 'signed-project-webhooks',
    },
  }
}

const credentialKey = String.raw`(?:[a-z][a-z0-9_-]{0,48}[_-])?(?:password|passwd|token|api[_ -]?key|secret|authorization)`
const nextCredential = (quote) => String.raw`(?:\{?${quote}${credentialKey}${quote}[ \t]*[:=]|\b["']?${credentialKey}["']?[ \t]*[:=][ \t]*${quote}(?![ \t]*(?:[\r\n]|$))(?:(?:\\[^\r\n]|[^${quote}\\\r\n])*${quote}|(?:\\[\s\S]|[^${quote}\\])*${quote}(?=[ \t]*(?:[\r\n,;})>\]]|$))))`
const quotedValue = (quote) => String.raw`${quote}(?:(?:\\[\s\S]|(?!${nextCredential(quote)})[^${quote}\\])*${quote}|(?:(?!${nextCredential(quote)})[^\r\n])*)`
const quotedCredential = String.raw`${quotedValue('"')}|${quotedValue("'")}`
const credentialAssignment = new RegExp(String.raw`((?:(["'])${credentialKey}\2|\b${credentialKey})\s*[:=]\s*)(?:${quotedCredential}|(?!\[credential omitted\])((?:(?![,;][ \t]*(?:[a-z_][\w-]*[ \t]*=|(?:"${credentialKey}"|'${credentialKey}'|${credentialKey})[ \t]*[:=]))[^\s"'])+))`, 'gi')

function normalizePreview(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
}

function preview(text, secret) {
  const normalizedSecret = normalizePreview(secret)
  const normalized = normalizePreview(text.replaceAll(secret, '[credential omitted]'))
  return (normalizedSecret ? normalized.replaceAll(normalizedSecret, '[credential omitted]') : normalized)
    .replace(tokenLike, '[credential omitted]')
    .replace(/((?:\bauthorization|"authorization"|'authorization')[ \t]*[:=][ \t]*(?:\r?\n[ \t]+)?)(?:basic|bearer)(?:[ \t]*\r?\n[ \t]+|[ \t]+)[a-z0-9._~+\/=-]+/gi, '$1[credential omitted]')
    .replace(/\bbearer\s+[a-zA-Z0-9._~+\/=-]{12,}/gi, '[credential omitted]')
    .replace(/\bbasic\s+([a-z0-9+\/=]+)/gi, (match, token) => {
      try {
        const decoded = atob(token)
        const encoded = btoa(decoded)
        if ((token === encoded || token === encoded.replace(/=+$/, '')) &&
          decoded.includes(':') && !/[\x00-\x1f\x7f]/.test(decoded)) return '[credential omitted]'
      } catch {
        return match
      }
      return match
    })
    .replace(credentialAssignment, (_match, prefix, keyQuote, bareValue, offset, source) => {
      let suffix = ''
      if (bareValue) {
        if (/^(?:password|passwd|token|secret|api key)[ \t]*:[ \t]+$/i.test(prefix) &&
          /^[a-z]{1,5}$/i.test(bareValue) && /^[ \t]+[a-z]/i.test(source.slice(offset + _match.length))) return _match
        const closer = { '(': ')', '[': ']', '{': '}', '<': '>' }[source[offset - 1]]
        const jsonObject = keyQuote === '"' && source.lastIndexOf('{', offset - 1) >
          Math.max(source.lastIndexOf('}', offset - 1), source.lastIndexOf('\n', offset - 1))
        const delimiter = closer ?? (jsonObject ? '}' : '')
        if (delimiter && bareValue.endsWith(delimiter)) suffix = delimiter
        else if (jsonObject && bareValue.endsWith(',')) suffix = ','
      }
      return keyQuote ? `${prefix}"[credential omitted]"${suffix}` : `${prefix}[credential omitted]${suffix}`
    })
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credential omitted]@')
}

function textOf(value, onOmission, depth = 0) {
  if (typeof value === 'string' || value === null) return value
  if (depth === 24 || typeof value !== 'object' || !value) {
    onOmission()
    return undefined
  }
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  if (value.type === 'hardBreak') return '\n'
  if (!Array.isArray(value.content)) {
    onOmission()
    return undefined
  }
  const children = value.content.map(child => textOf(child, onOmission, depth + 1))
  return children.filter(child => child !== undefined).join(['paragraph', 'heading', 'codeBlock'].includes(value.type) ? '' : '\n')
}

function projector(secret) {
  return (value, onOmission = () => {}) => {
    const text = textOf(value, onOmission)
    if (typeof text !== 'string') return text
    const output = preview(text, secret)
    return output.length > previewLimit ? output.slice(0, previewLimit).toWellFormed() + '…' : output
  }
}

function scopedIssue(engine, issue) {
  const id = nativeId(issue?.id)
  if (!id || typeof issue?.key !== 'string' || !issueKey.test(issue.key)) return undefined
  const { source } = engine
  if (nativeId(issue.fields?.project?.id) !== source.project_id) return undefined
  if (issue.self !== undefined) {
    try {
      const self = new URL(issue.self)
      if (self.origin !== source.site || self.username || self.password) return undefined
    } catch {
      return undefined
    }
  }
  return { id, key: issue.key, fields: issue.fields }
}

function changedField(item, fields) {
  if (typeof item?.fieldId === 'string' && item.fieldId) {
    return builtInFields.get(item.fieldId) ?? Object.keys(fields).find(name => fields[name] === item.fieldId)
  }
  if (typeof item?.field !== 'string') return undefined
  if (item.fieldtype === 'custom') return undefined
  return builtInFields.get(item.field)
}

function side(item, key, redact) {
  const text = item[key + 'String']
  if (typeof text === 'string') return redact(text)
  const value = item[key]
  const id = nativeId(value)
  if (id || (typeof value === 'string' && issueKey.test(value))) return value
  if (has(item, key + 'String') && text === null && value == null) return null
  return undefined
}

function eventTime(timestamp) {
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000_000) return null
  return new Date(timestamp).toISOString()
}

function normalize(config, body, issue, delivery, observedAt, secret) {
  const redact = projector(secret)
  const { webhookEvent: event, timestamp } = body
  const { source, fields } = config
  const changelogId = nativeId(body.changelog?.id)
  const commentId = event === 'comment_created' && nativeId(body.comment?.id)
  const accountId = user => typeof user?.accountId === 'string' && nativeIdentifier.test(user.accountId) ? redact(user.accountId) : undefined
  const actor = accountId(body.user)
  const author = commentId ? accountId(body.comment?.author) : undefined
  const native = event === 'jira:issue_created' ? `created:${issue.id}` :
    event === 'jira:issue_updated' && changelogId ? `changelog:${issue.id}:${changelogId}` :
      commentId ? `comment:created:${issue.id}:${commentId}` : null
  const envelope = {
    schema: 'event-publisher.event.v1',
    source: {
      provider: 'jira', source_id: source.source_id, cloud_id: source.cloud_id, site: source.site,
      project_id: source.project_id, delivery_id: delivery,
    },
    subject: { type: 'ticket', id: `jira:ticket:${source.cloud_id}:${issue.id}` },
    observed_at: observedAt, occurred_at: eventTime(timestamp),
    observation: { method: 'webhook', read_method: 'jira-admin-webhook', coverage: source.coverage },
    related: [],
    evidence: {
      source_reference: {
        interface: 'Jira Cloud admin webhook', issue_id: issue.id, issue_key: issue.key,
        webhook_event: event, ...(changelogId ? { changelog_id: changelogId } : {}),
        ...(commentId ? { comment_id: commentId } : {}), ...(actor ? { account_id: actor } : {}),
        ...(author ? { comment_author_id: author } : {}),
      },
      confidence_basis: 'signed Jira delivery',
    },
  }
  const entry = (suffix, change, omissions = []) => ({
    ...envelope, event_type: `ticket.${suffix}`, change,
    ...(omissions.length ? { observation: { ...envelope.observation, projection_omissions: omissions } } : {}),
  })
  let events = []
  let reason
  if (event === 'jira:issue_created') {
    const after = Object.fromEntries([
      ['summary', redact(issue.fields.summary)], ['status', redact(issue.fields.status?.name)],
      ['issue_type', redact(issue.fields.issuetype?.name)],
    ].filter(([, value]) => typeof value === 'string'))
    events = [entry('created', { after })]
  } else if (event === 'jira:issue_updated') {
    if (!Array.isArray(body.changelog?.items)) {
      reason = 'Jira update omitted changelog items'
    } else {
      for (const item of body.changelog.items) {
        const field = changedField(item, fields)
        if (!field) continue
        const before = side(item, 'from', redact)
        const after = side(item, 'to', redact)
        const omissions = []
        if (before === undefined) omissions.push('before')
        if (after === undefined) omissions.push('after')
        if (omissions.length) reason = 'Jira omitted values for a tracked change'
        events.push(entry(`${field}.changed`, {
          field, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }),
        }, omissions))
      }
    }
  } else if (event === 'comment_created') {
    if (!commentId) {
      reason = 'Jira comment delivery omitted a native comment ID'
    } else {
      const restricted = body.comment.visibility != null
      if (restricted) envelope.evidence.source_reference.comment_visibility_restricted = true
      const content = restricted ? undefined : redact(body.comment.body, () => {
        reason = 'Jira comment body could only be partially projected'
      })
      events = [entry('comment.created', {
        field: 'comment', ...(content === undefined ? {} : { after: content }),
      }, reason ? ['comment body'] : [])]
    }
  }
  return { events, native, observedAt, reason }
}

const acceptedEvents = new Set(['jira:issue_created', 'jira:issue_updated', 'comment_created'])

export async function startJiraWebhook(journal, config, secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new JiraWebhookConfigurationError('set EVENTS_JIRA_WEBHOOK_SECRET from the Jira admin webhook secret')
  }
  const key = Buffer.from(secret, 'utf8')
  const respond = (res, status) => {
    res.writeHead(status, status >= 400 ? { Connection: 'close' } : {})
    res.end()
  }
  const receive = async (req, res) => {
    if (req.url !== webhookPath) return respond(res, 404)
    if (req.method !== 'POST') return respond(res, 405)
    const signature = /^sha256=([a-f0-9]{64})$/i.exec(req.headers['x-hub-signature'] ?? '')
    if (!signature) return respond(res, 401)
    if (Number(req.headers['content-length']) > bodyLimit) return respond(res, 413)
    const hash = createHmac('sha256', key)
    const chunks = []
    let bytes = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > bodyLimit) return respond(res, 413)
      chunks.push(chunk)
      hash.update(chunk)
    }
    if (!timingSafeEqual(hash.digest(), Buffer.from(signature[1], 'hex'))) return respond(res, 401)

    let body
    try {
      body = JSON.parse(decoder.decode(Buffer.concat(chunks)))
    } catch {
      return respond(res, 400)
    }
    if (!acceptedEvents.has(body?.webhookEvent)) return respond(res, 204)
    const issue = scopedIssue(config, body.issue)
    if (!issue) return respond(res, 403)
    const id = req.headers['x-atlassian-webhook-identifier']
    // Jira uses this tenant-scoped identifier unchanged on retry.
    if (typeof id !== 'string' || !/^[!-~]{1,256}$/.test(id) || preview(id, secret) !== id) return respond(res, 400)
    const notice = normalize(config, body, issue, id, new Date().toISOString(), secret)
    journal.recordJiraDelivery(config.source.source_id, id, notice)
    respond(res, 204)
  }
  const server = createServer({ headersTimeout: 5000, requestTimeout: 10000 }, (req, res) => {
    void receive(req, res).catch(() => {
      if (!res.destroyed && !res.headersSent) respond(res, 503)
    })
  })
  // Bound concurrent input buffers when the loopback endpoint is proxied.
  server.maxConnections = 32
  server.setTimeout(10000, socket => socket.destroy())
  server.listen(port, host)
  try {
    await once(server, 'listening')
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new JiraWebhookConfigurationError(`Jira webhook port ${port} is already in use`)
    throw error
  }
  return {
    url: `http://${host}:${port}${webhookPath}`,
    close: () => new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}
