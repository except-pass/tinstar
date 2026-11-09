#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Credentials stay in memory: never include response bodies, network/SDK errors,
// command arguments or headers in an alert. Refuse redirects carrying secrets.
export async function http(url, { method = 'GET', headers = {}, body, timeout = 10_000 } = {}) {
  const response = await fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (response.status !== 200) throw new Error('HTTP check failed')
  return response
}
async function data(url, options) {
  const value = await (await http(url, options)).json()
  if (value.ok !== true) throw new Error('Ask envelope failed')
  return value.data
}
export async function askSmoke({ ownerBase, bridgeBase, configHome }) {
  const { ask } = JSON.parse(await readFile(resolve(configHome, 'config.json'), 'utf8'))
  if (!ask?.ownerLogins?.length || typeof ask.bridgeToken !== 'string' || ask.bridgeToken.length < 32) throw new Error('Ask configuration unavailable')
  const syntheticId = randomUUID(), key = randomUUID()
  const auth = { Authorization: `Bearer ${ask.bridgeToken}`, 'Content-Type': 'application/json' }
  // On the tailnet URL Tailscale Serve authenticates/injects the login. On the
  // loopback preview this exercises the same owner route with the configured login.
  const ownerHeaders = { ...auth, 'Tailscale-User-Login': ask.ownerLogins[0], 'X-Tinstar-UI': '1' }
  const bridgeUrl = `${bridgeBase}/api/ask/bridge?synthetic_id=${syntheticId}`
  try {
    const row = await data(`${ownerBase}/api/ask/requests`, { method: 'POST', headers: ownerHeaders, body: {
      synthetic_id: syntheticId, client_key: key, card_id: '00000000000000000000000000000000',
      question: `Deploy smoke ${key}`, view: { scene: 'overview' },
    } })
    const work = await data(bridgeUrl, { headers: auth })
    if (work.pending?.length !== 1 || work.pending[0].request_id !== row.request_id) throw new Error('Synthetic dispatch missing')
    const payload = JSON.parse(work.pending[0].body.split('\n')[1])
    if (payload.question !== row.question || payload.request_id !== row.request_id || payload.requesting_principal !== ask.ownerLogins[0]) throw new Error('Synthetic dispatch payload mismatch')
    const ordinary = await data(`${bridgeBase}/api/ask/bridge`, { headers: auth })
    if ([...ordinary.pending, ...ordinary.tracked].some(item => item.request_id === row.request_id)) throw new Error('Synthetic work leaked to puller')
    const noteId = `smoke-${syntheticId}`, reply = `Synthetic answer ${key}`
    await data(bridgeUrl, { method: 'POST', headers: auth, body: { request_id: row.request_id, note: {
      schema: 'fm-inbox-note.v1', outcome: 'created', id: noteId, request_id: work.pending[0].inbox_request_id,
      saved: true, announced: true, acknowledged: false,
    } } })
    await data(bridgeUrl, { method: 'POST', headers: auth, body: { request_id: row.request_id, reply: {
      id: noteId, at: new Date().toISOString(), cursor: '1', body: reply,
    } } })
    const conversation = await data(`${ownerBase}/api/ask/conversations/${row.conversation_id}?synthetic_id=${syntheticId}`, { headers: ownerHeaders })
    if (conversation.turns?.at(-1)?.reply?.detail !== reply) throw new Error('Synthetic answer missing')
    const desk = await data(`${ownerBase}/api/ask/requests`, { headers: ownerHeaders })
    if (desk.some(item => item.request_id === row.request_id)) throw new Error('Synthetic work leaked to Desk')
  } finally {
    // The client-chosen partition is known even if the create response was lost.
    // A cleanup failure fails the smoke and leaves the deploy block for recovery.
    await data(bridgeUrl, { method: 'DELETE', headers: auth })
  }
}

// Plain stateless JSON-RPC is the facade/shim's existing public MCP interface.
// Read all pages so a paginated extra tool cannot evade the approved scope check.
export async function toolsList(url, authorization) {
  const tools = [], cursors = new Set()
  let cursor
  do {
    const result = await (await http(url, { method: 'POST', headers: {
      Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
    }, body: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: cursor ? { cursor } : {} } })).json()
    if (result.error || !Array.isArray(result.result?.tools)) throw new Error('MCP tools/list failed')
    tools.push(...result.result.tools)
    cursor = result.result.nextCursor
    if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('MCP catalog pagination failed')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return tools
}
// Only messages constructed here may be printed; SDK/network errors can contain secrets.
class CatalogMismatch extends Error {}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function schemaMeaning(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    // Normalize only schema sets. Defaults, examples, const values and tuple
    // schemas are data: their array ordering must retain its meaning.
    if (['required', 'enum', 'type', 'allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(value)) {
      const items = value.map(item => ['allOf', 'anyOf', 'oneOf'].includes(key) ? schemaMeaning(item) : canonical(item))
      return [key, items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
    }
    if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key) && value && typeof value === 'object') {
      return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaMeaning(child)]))]
    }
    if (['items', 'prefixItems', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'contentSchema'].includes(key)) {
      return [key, Array.isArray(value) ? value.map(schemaMeaning) : schemaMeaning(value)]
    }
    return [key, value]
  }))
}
const toolMeaning = tool => canonical({ ...tool,
  ...(tool.inputSchema === undefined ? {} : { inputSchema: schemaMeaning(tool.inputSchema) }),
  ...(tool.outputSchema === undefined ? {} : { outputSchema: schemaMeaning(tool.outputSchema) }),
})
export function compareCatalogs(facade, target, approved) {
  const names = facade.map(tool => tool.name).sort()
  const missing = approved.filter(name => !names.includes(name)).sort()
  const added = names.filter(name => !approved.includes(name))
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
  const approvedDuplicates = approved.filter((name, index) => approved.indexOf(name) !== index)
  if (!approved.length || missing.length || added.length || duplicates.length || approvedDuplicates.length) {
    throw new CatalogMismatch(`Facade differs from approved tools: missing=${JSON.stringify(missing)}, added=${JSON.stringify(added)}, duplicate=${JSON.stringify(duplicates)}, approved-duplicate=${JSON.stringify(approvedDuplicates)}`)
  }
  const normalize = tools => [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(toolMeaning)
  if (JSON.stringify(normalize(facade)) !== JSON.stringify(normalize(target))) {
    const targetNames = target.map(tool => tool.name)
    const changed = facade.filter(tool => target.some(other => other.name === tool.name && JSON.stringify(toolMeaning(tool)) !== JSON.stringify(toolMeaning(other)))).map(tool => tool.name)
    throw new CatalogMismatch(`Tunnel target differs from facade catalog: missing=${JSON.stringify(names.filter(name => !targetNames.includes(name)))}, added=${JSON.stringify(targetNames.filter(name => !names.includes(name)))}, changed=${JSON.stringify(changed)}, duplicate=${JSON.stringify(targetNames.filter((name, index) => targetNames.indexOf(name) !== index))}`)
  }
}
export function publicationEvidence(status, metrics, facadeStartedAt, targetUrl) {
  const facadeStart = Date.parse(facadeStartedAt), tunnelStart = Date.parse(status.started_at)
  const pollTimes = [...metrics.matchAll(/^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+(\S+)/gm)].map(match => Number(match[1]) * 1000)
  const main = status.channels?.find(channel => channel.name === 'main' && channel.enabled)
  const configuredUrl = main?.details?.find(detail => detail.value === targetUrl)
  // tunnel-client 0.0.20 prevents polling until its startup catalog succeeds.
  // Restarting after the facade and polling afterwards rules out a stale startup
  // catalog. This is publication evidence, not a readback of the remote copy.
  if (!Number.isFinite(facadeStart) || !Number.isFinite(tunnelStart) || tunnelStart < facadeStart ||
      !pollTimes.some(at => Number.isFinite(at) && at >= tunnelStart) || main?.probe_status !== 'ok' || !configuredUrl) throw new Error('Fresh startup catalog publication evidence unavailable')
}
export async function mcpSmoke({ facadeUrl, targetUrl, healthBase, callerFile, approvedFile, facadeStartedAt }) {
  const header = await readFile(callerFile, 'utf8')
  if (!/^Bearer [^\s]{32,}(?:\r?\n)?$/.test(header)) throw new Error('Caller header unavailable')
  const authorization = header.trim()
  await http(`${healthBase}/readyz`)
  const facade = await toolsList(facadeUrl, authorization)
  const target = await toolsList(targetUrl, authorization)
  compareCatalogs(facade, target, JSON.parse(await readFile(approvedFile, 'utf8')))
  const status = await (await http(`${healthBase}/api/status`)).json()
  const metrics = await (await http(`${healthBase}/metrics`)).text()
  publicationEvidence(status, metrics, facadeStartedAt, targetUrl)
  await http(`${healthBase}/readyz`)
}

async function main() {
  const e = process.env
  let phase = 'Ask'
  try {
    const deadline = Date.now() + Number(e.TINSTAR_SMOKE_WAIT_MS ?? 60_000)
    // Startup can take a moment after systemctl returns. Only the read-only ready
    // probe retries: a failed synthetic write is never silently retried as success.
    while (true) {
      try { await http(`${e.TINSTAR_OWNER_URL ?? 'https://hulk.taile890bc.ts.net:8450'}/api/ask/requests`, {
        headers: { 'Tailscale-User-Login': JSON.parse(await readFile(resolve(e.TINSTAR_CONFIG_HOME, 'config.json'), 'utf8')).ask.ownerLogins[0], 'X-Tinstar-UI': '1' }, timeout: 3000,
      }); break } catch { if (Date.now() >= deadline) throw new Error('Owner route unavailable'); await new Promise(resolve => setTimeout(resolve, 500)) }
    }
    await askSmoke({ ownerBase: e.TINSTAR_OWNER_URL ?? 'https://hulk.taile890bc.ts.net:8450', bridgeBase: e.TINSTAR_BRIDGE_URL ?? 'http://127.0.0.1:5281', configHome: e.TINSTAR_CONFIG_HOME })
    console.log('Ask smoke passed; synthetic record removed')
    phase = 'MCP'
    const facadeStartedAt = e.TINSTAR_FACADE_STARTED_AT ?? execFileSync('systemctl', ['show', e.TINSTAR_FACADE_UNIT ?? 'tinstar-mcp-facade', '--property=ActiveEnterTimestamp', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    while (true) {
      try {
        await mcpSmoke({ facadeUrl: e.TINSTAR_FACADE_URL ?? 'http://127.0.0.1:5297/mcp', targetUrl: e.TINSTAR_TUNNEL_TARGET_URL ?? 'http://127.0.0.1:5297/mcp',
      healthBase: e.TINSTAR_TUNNEL_HEALTH_URL ?? 'http://127.0.0.1:5298', callerFile: e.TINSTAR_CALLER_HEADER_FILE ?? '/home/farm/.config/tinstar-tunnel/facade-caller-header',
      approvedFile: e.TINSTAR_APPROVED_TOOLS_FILE ?? fileURLToPath(new URL('./approved-tools.json', import.meta.url)), facadeStartedAt })
        break
      } catch (error) {
        if (error instanceof CatalogMismatch) throw error
        if (Date.now() >= deadline) throw new Error('MCP startup checks unavailable')
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    console.log('MCP smoke passed; ready, approved target catalog matches facade, fresh startup poll verified')
  } catch (error) {
    console.error(`${phase} post-deploy smoke failed (credentials and response bodies withheld)`)
    if (error instanceof CatalogMismatch) console.error(error.message)
    process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
