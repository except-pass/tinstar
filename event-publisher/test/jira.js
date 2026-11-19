import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../events', import.meta.url))
const exec = promisify(execFile)
const localUrl = 'http://127.0.0.1:18573'
const webhook = localUrl + '/webhooks/jira'
const secret = 'synthetic-jira-webhook-secret-for-the-fixture'
const jira = {
  site: 'https://example.atlassian.net', cloudId: '11111111-2222-4333-8444-555555555555',
  projectId: '12345',
  fields: { owner: 'customfield_12001', decisions: 'customfield_12002', blockerType: 'customfield_12003',
    blockerTarget: 'customfield_12004', blockerCondition: 'customfield_12005' },
}
const occurred = Date.UTC(2026, 0, 1, 12, 30)
const issue = {
  id: '98765', key: 'WORK-1', self: `${jira.site}/rest/api/2/issue/98765`,
  fields: { project: { id: jira.projectId }, summary: 'Inspect the source journal', status: { name: 'Backlog' }, issuetype: { name: 'Task' } },
}
const webhookEvent = (name, fields = {}) => ({
  timestamp: occurred, webhookEvent: name, issue,
  user: { accountId: '123:synthetic-actor', emailAddress: 'private@example.test' }, ...fields,
})
const signature = bytes => 'sha256=' + createHmac('sha256', secret).update(bytes).digest('hex')

async function until(condition, diagnostics = () => '') {
  const deadline = Date.now() + 8_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for publisher fixture. ${diagnostics()}`)
    await sleep(20)
  }
}

function start(t, args, env = process.env) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => { logs.stdout += chunk })
  child.stderr.on('data', chunk => { logs.stderr += chunk })
  const exited = once(child, 'close')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    return exited
  }
  t.after(stop)
  return { logs, stop }
}

async function post(delivery, payload, { url = webhook, signed = true, headers = {} } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return fetch(url, { method: 'POST', body, headers: {
    'Content-Type': 'application/json',
    ...(delivery == null ? {} : { 'X-Atlassian-Webhook-Identifier': delivery }),
    ...(signed ? { 'X-Hub-Signature': signature(body) } : {}), ...headers,
  } })
}

test('serve verifies signed Jira deliveries and replays one durable project-scoped stream across restart', { timeout: 25_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'event-publisher-jira-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, 'config.json')
  const dbPath = join(directory, 'journal.sqlite')
  const envCheck = join(directory, 'firstmate-env-check')
  await mkdir(join(directory, 'bin'))
  await writeFile(join(directory, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh
if [ "${'${EVENTS_JIRA_WEBHOOK_SECRET+x}'}" ]; then result=inherited; else result=clear; fi
printf '%s\\n' "$result" > "$FM_HOME/firstmate-env-check"
exit 1
`, { mode: 0o700 })
  const { decisions: _missing, ...partialFields } = jira.fields
  await writeFile(configPath, JSON.stringify({ jira: { ...jira, fields: partialFields }, homes: [] }))
  await rejects(exec(process.execPath, [cli, 'serve', '--config', configPath, '--db', dbPath], {
    env: { ...process.env, EVENTS_JIRA_WEBHOOK_SECRET: secret },
  }), error => error.code === 1 && error.stderr.includes('all five distinct native custom field IDs'))
  await writeFile(configPath, JSON.stringify({ jira, homes: [{ id: 'example', path: directory, mode: 'fixture' }] }))
  const args = ['serve', '--config', configPath, '--db', dbPath]
  const run = (...flags) => exec(process.execPath, [cli, ...flags, '--db', dbPath])
  await rejects(exec(process.execPath, [cli, ...args], { env: { ...process.env, EVENTS_JIRA_WEBHOOK_SECRET: '' } }),
    error => error.code === 2 && error.stderr.includes('EVENTS_JIRA_WEBHOOK_SECRET'))
  const serve = () => start(t, args, { ...process.env, EVENTS_JIRA_WEBHOOK_SECRET: secret })
  let publisher = serve()
  await until(() => publisher.logs.stderr.includes(`Jira webhook listening on ${webhook}`), () => publisher.logs.stderr)
  await until(() => existsSync(envCheck) && readFileSync(envCheck, 'utf8').endsWith('\n'))
  equal(readFileSync(envCheck, 'utf8'), 'clear\n')

  equal((await fetch(webhook)).status, 405)
  equal((await post('wrong-path', webhookEvent('jira:issue_created'), { url: localUrl + '/other' })).status, 404)
  equal((await post('wrong-path', webhookEvent('jira:issue_created'), { url: webhook + '?extra' })).status, 404)
  equal((await post('unsigned', '{ invalid JSON', { signed: false })).status, 401)
  equal((await post('bad-body', '{ invalid JSON', { headers: { 'X-Hub-Signature': signature('different bytes') } })).status, 401)
  equal((await post('signed-invalid-json', '{ invalid JSON')).status, 400)
  equal((await post(null, webhookEvent('jira:issue_created'))).status, 400)
  equal((await post('foreign-project', webhookEvent('jira:issue_created', {
    issue: { ...issue, fields: { ...issue.fields, project: { id: '99999' } } },
  }))).status, 403)
  equal((await post('foreign-site', webhookEvent('jira:issue_created', {
    issue: { ...issue, self: 'https://other.atlassian.net/rest/api/2/issue/98765' },
  }))).status, 403)
  const oversized = await new Promise((resolve, reject) => {
    const req = request(webhook, { method: 'POST', headers: {
      'Content-Length': '1048577', 'X-Hub-Signature': signature('bogus bytes'),
    } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  equal(oversized, 413)
  equal((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout, '')

  const watcher = start(t, ['watch', '--source', 'jira', '--type', 'ticket', '--db', dbPath, '--json'])
  await until(() => watcher.logs.stderr.includes('Watching from sequence 0'))
  const change = (fieldId, fromString, toString) => ({ fieldId, fromString, toString })
  const pat = 'github_pat_1234567890abcdef1234567890abcdef'
  const update = webhookEvent('jira:issue_updated', { changelog: { id: '65001', items: [
    change('description', 'Before', `Résumé after ${pat}`),
    change(jira.fields.owner, null, 'Avery'),
    change('status', 'To Do', 'Decision'),
    change(jira.fields.decisions, 'D1 [Open]\nD2 [Open]', 'D1 [Answered]\nD2 [Open]'),
    { fieldtype: 'custom', field: 'Decision Questions', toString: 'private payload metadata' },
    change(jira.fields.blockerType, 'Actor', 'Event'),
    change(jira.fields.blockerTarget, 'actor:reviewer', 'event:approval'),
    change(jira.fields.blockerCondition, 'Reviewer replies', 'Approval is recorded'),
    { fieldId: 'private_wrong_field', fieldtype: 'custom', field: 'Owner', fromString: 'secret text', toString: 'private payload metadata' },
    change('priority', 'Medium', 'High'),
  ] } })
  const fault = new DatabaseSync(dbPath)
  try {
    fault.exec(`
      CREATE TRIGGER reject_fixture_status BEFORE INSERT ON events
      WHEN json_extract(NEW.envelope, '$.change.field') = 'status'
      BEGIN SELECT RAISE(ABORT, 'fixture append failure'); END
    `)
    equal((await post('delivery-update', update)).status, 503)
    equal((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout, '')
    fault.exec('DROP TRIGGER reject_fixture_status')
  } finally {
    fault.close()
  }
  equal((await post('delivery-update', update)).status, 204)
  equal((await post('delivery-update', update, { headers: { 'X-Atlassian-Webhook-Retry': '1' } })).status, 204)
  equal((await post('new-header-same-changelog', update)).status, 204)

  const lines = output => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const expected = ['description', 'owner', 'status', 'decisions', 'blockerType', 'blockerTarget', 'blockerCondition']
  await until(() => watcher.logs.stdout.trim().split('\n').length >= expected.length, () => watcher.logs.stderr)
  const updates = lines((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout)
  deepEqual(updates.map(event => event.change.field), expected)
  equal(updates[0].change.after, 'Résumé after [credential omitted]')
  deepEqual(updates[3].change, { field: 'decisions', before: 'D1 [Open]\nD2 [Open]', after: 'D1 [Answered]\nD2 [Open]' })
  equal(updates[2].subject.id, `jira:ticket:${jira.cloudId}:${issue.id}`)
  equal(updates[2].occurred_at, new Date(occurred).toISOString())
  equal(updates[2].source.delivery_id, 'delivery-update')
  equal(updates[2].source.mode, undefined)
  equal(updates[2].evidence.source_reference.changelog_id, '65001')
  equal(updates[2].observation.method, 'webhook')
  ok(Date.parse(updates[2].observed_at) >= occurred)
  ok(!JSON.stringify(updates).includes('private@example.test'))
  ok(!JSON.stringify(updates).includes('private payload metadata'))

  equal((await post('missing-changelog', webhookEvent('jira:issue_updated'))).status, 204)
  match((await run('sources')).stdout, /partial · signed-project-webhooks · Jira update omitted changelog items/)
  deepEqual(lines((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout), updates)

  equal((await post('new-ticket', webhookEvent('jira:issue_created', { issue: { ...issue, id: '98766', key: 'WORK-2', fields: { ...issue.fields, summary: pat } } }))).status, 204)
  const links = (id, fromString, toString) => webhookEvent('jira:issue_updated', {
    changelog: { id, items: [{ field: 'Link', fieldtype: 'jira', fromString, toString }] },
  })
  equal((await post('linked', links('65002', null, 'This issue is blocked by OTHER-99'))).status, 204)
  equal((await post('unlinked', links('65003', 'This issue is blocked by OTHER-99', null))).status, 204)
  const unsafe = 'ATATTabcdefghijklmnop0123456789'
  const evidence = webhookEvent('comment_created', {
    user: undefined,
    comment: { id: '84001', author: { accountId: '123:comment-author' }, body: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: `Signed review evidence: ${secret} and ${unsafe} and ${pat}\u001b[31m` }] },
      { type: 'paragraph', content: [{ type: 'text', text: '{"password":\'first\nTOKEN=123\n"TOKEN"="inner"\nprivate-tail\' }' }] },
      { type: 'paragraph', content: [{ type: 'text', text: String.raw`Second line password: "short two-word-passphrase" and token='tiny escaped \' value' and {"password":"two word passphrase"} and {"token":"clipped passphrase` }] },
      { type: 'paragraph', content: [{ type: 'text', text: '{"AUTHORIZATION":"second fixture value"}' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'PASSWORD="first\nprivate-tail TOKEN=" trailing prose\n"ordinary quotation"' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'PASSWORD="clipped\nTOKEN="first\nprivate-tail")' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'TO\u202eKEN=opaqueFixtureValue' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'PASSWORD="clipped {"TOKEN":"opaque phrase"}' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'TOKEN=4821 PASSWORD=a!b count=4821 "TOKEN": opaqueValue (PASSWORD=prefix]suffix) ["TOKEN": prefix)suffix]\nPASSWORD=]]}> TOKEN=opaque]] (PASSWORD=]]>) end\n{"password":123456789,"count":123456789,"token":-1.2e+3}\nPASSWORD=firstValue,TOKEN: secondValue, "API KEY" = thirdValue,"SECRET": fourthValue end\nAuthorization: Basic dTpw and Authorization=Basic YTpiYw== done\nAuthorization:\n  Basic dTpw\nBasic YTpiYw==\nAuthorization: Basic\n  dTpw\nBasic dTpw.\nBasic YTpiYw==, next\nBasic information\nBasic configuration is required' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'D2 [Open]: What follows?' }] },
    ] } },
  })
  equal((await post('comment', evidence)).status, 204)
  const comment = lines((await run('replay', '--source', 'jira', '--last', '1', '--json')).stdout)[0]
  equal(comment.event_type, 'ticket.comment.created')
  equal(comment.evidence.source_reference.comment_id, '84001')
  equal(comment.evidence.source_reference.comment_author_id, '123:comment-author')
  equal(comment.evidence.source_reference.account_id, undefined)
  equal(comment.change.after, 'Signed review evidence: [credential omitted] and [credential omitted] and [credential omitted][31m\n{"password":"[credential omitted]" }\nSecond line password: [credential omitted] and token=[credential omitted] and {"password":"[credential omitted]"} and {"token":"[credential omitted]"\n{"AUTHORIZATION":"[credential omitted]"}\nPASSWORD=[credential omitted] trailing prose\n"ordinary quotation"\nPASSWORD=[credential omitted]\nTOKEN=[credential omitted])\nTOKEN=[credential omitted]\nPASSWORD=[credential omitted]{"TOKEN":"[credential omitted]"}\nTOKEN=[credential omitted] PASSWORD=[credential omitted] count=4821 "TOKEN": "[credential omitted]" (PASSWORD=[credential omitted]) ["TOKEN": "[credential omitted]"]\nPASSWORD=[credential omitted] TOKEN=[credential omitted] (PASSWORD=[credential omitted]) end\n{"password":"[credential omitted]","count":123456789,"token":"[credential omitted]"}\nPASSWORD=[credential omitted],TOKEN: [credential omitted], "API KEY" = "[credential omitted]","SECRET": "[credential omitted]" end\nAuthorization: [credential omitted] and Authorization=[credential omitted] done\nAuthorization:\n  [credential omitted]\n[credential omitted]\nAuthorization: [credential omitted]\n[credential omitted].\n[credential omitted], next\nBasic information\nBasic configuration is required\nD2 [Open]: What follows?')
  ok(!JSON.stringify(comment).includes(secret))
  ok(!JSON.stringify(comment).includes(unsafe))
  equal((await run('replay', '--source', 'firstmate', '--after', '0', '--json')).stdout, '')
  const allAtStop = lines((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout)
  equal(allAtStop.length, 11)
  equal(allAtStop.filter(event => event.event_type === 'ticket.created').length, 1)
  equal(allAtStop.find(event => event.event_type === 'ticket.created').change.after.summary, '[credential omitted]')
  deepEqual(allAtStop.filter(event => event.change.field === 'links').map(event => event.change), [
    { field: 'links', before: null, after: 'This issue is blocked by OTHER-99' },
    { field: 'links', before: 'This issue is blocked by OTHER-99', after: null },
  ])
  const [stopCode] = await publisher.stop()
  equal(stopCode, 0)
  publisher = serve()
  await until(() => publisher.logs.stderr.includes(`Jira webhook listening on ${webhook}`), () => publisher.logs.stderr)
  equal((await post('comment', evidence, { headers: { 'X-Atlassian-Webhook-Retry': '2' } })).status, 204)
  equal((await post('delivery-update', update)).status, 204)
  deepEqual(lines((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout), allAtStop)
  deepEqual(JSON.parse((await run('inspect', comment.event_id)).stdout), comment)
  const terminal = (await run('replay', '--source', 'jira', '--last', '1')).stdout
  match(terminal, /\[replay\] jira\/ticket WORK-1 · comment 84001 created/)
  match(terminal, /↵ Second line/)
  ok(!terminal.includes(secret))
  const mixed = { ...evidence.comment, id: '85001', body: { type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'Review with ' }, { type: 'mention', attrs: { id: 'account' } },
      { type: 'text', text: ' before shipping' },
    ] },
  ] } }
  equal((await post('mixed-created', webhookEvent('comment_created', { comment: mixed }))).status, 204)
  const partial = lines((await run('replay', '--source', 'jira', '--last', '1', '--json')).stdout)[0]
  equal(partial.change.after, 'Review with  before shipping')
  match((await run('sources')).stdout, /partial · signed-project-webhooks · Jira comment body could only be partially projected/)
  const restricted = { ...mixed, id: '86001', visibility: { type: 'role', value: 'Administrators' } }
  equal((await post('restricted-created', webhookEvent('comment_created', { comment: restricted }))).status, 204)
  const redacted = lines((await run('replay', '--source', 'jira', '--last', '1', '--json')).stdout)[0]
  equal(redacted.evidence.source_reference.comment_visibility_restricted, true)
  deepEqual(redacted.change, { field: 'comment' })
  const missingValues = {
    summary: 'summary', description: 'description', status: 'status', ...jira.fields, links: 'issuelinks',
  }
  equal((await post('missing-values', webhookEvent('jira:issue_updated', {
    changelog: { id: '65004', items: Object.values(missingValues).map(fieldId => ({ fieldId })) },
  }))).status, 204)
  match((await run('sources')).stdout, /partial · signed-project-webhooks · Jira omitted values for a tracked change/)
  const observed = lines((await run('replay', '--source', 'jira', '--last', String(Object.keys(missingValues).length), '--json')).stdout)
  deepEqual(observed.map(event => ({ type: event.event_type, change: event.change })),
    Object.keys(missingValues).map(field => ({ type: `ticket.${field}.changed`, change: { field } })))
  equal((await post('one-sided', webhookEvent('jira:issue_updated', {
    changelog: { id: '65005', items: [{ fieldId: jira.fields.owner, toString: null }] },
  }))).status, 204)
  match((await run('sources')).stdout, /partial · signed-project-webhooks · Jira omitted values for a tracked change/)
  const oneSided = lines((await run('replay', '--source', 'jira', '--last', '1', '--json')).stdout)[0]
  deepEqual(oneSided.change, { field: 'owner', after: null })
  equal((await post('full-after-partial', webhookEvent('jira:issue_updated', {
    changelog: { id: '65006', items: [change(jira.fields.owner, null, 'Avery')] },
  }))).status, 204)
  match((await run('sources')).stdout, /ok · signed-project-webhooks/)
  const partialEventIds = [partial.event_id, oneSided.event_id]
  await until(() => partialEventIds.every(id => watcher.logs.stdout.includes(id)), () => watcher.logs.stderr)
  const replayed = lines((await run('replay', '--source', 'jira', '--after', '0', '--json')).stdout)
  for (const [index, id] of partialEventIds.entries()) {
    const omissions = index === 1 ? ['before'] : ['comment body']
    const inspected = JSON.parse((await run('inspect', id)).stdout)
    deepEqual(inspected.observation.projection_omissions, omissions)
    deepEqual(replayed.find(event => event.event_id === id), inspected)
    deepEqual(lines(watcher.logs.stdout).find(event => event.event_id === id).observation.projection_omissions, omissions)
  }
  const partialReplay = (await run('replay', '--source', 'jira', '--after', '0')).stdout
  match(partialReplay, /partial projection \(before\)/)
  match(partialReplay, /partial projection \(comment body\)/)
  await watcher.stop()
  await publisher.stop()
})
