// Standalone read-only fixture receipt. No application imports or mutations.
// Credentials remain in process memory and are never included in the output.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  'project-id': { type: 'string' }, 'issue-ids': { type: 'string' },
} })
if (!values['project-id'] || !values['issue-ids']) throw new Error('Supply --project-id and comma-separated --issue-ids from the report')
function credential(key) {
  try { return execFileSync('clavis', ['get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { throw new Error('Authorized Clavis credential unavailable; no value emitted') }
}
const site = new URL(credential('jira/prod.url'))
if (site.protocol !== 'https:' || site.username || site.password) throw new Error('Use the configured HTTPS Jira site without credentials in its URL')
const authorization = 'Basic ' + Buffer.from(credential('jira/prod.email') + ':' + credential('jira/prod.token')).toString('base64')
async function get(path) {
  const response = await fetch(site.origin + path, { redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json', Authorization: authorization } })
  const body = await response.json()
  return { status: response.status, body }
}
const items = []
for (const id of values['issue-ids'].split(',').map(id => id.trim())) {
  const result = await get(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=summary,status,project,issuetype,issuelinks,assignee,description`)
  if (result.status !== 200) {
    items.push({ id, http: result.status, availability: 'unknown' })
    continue
  }
  const issue = result.body
  // Prevent an accidentally supplied real-work ID from appearing in this proof.
  if (String(issue.fields.project.id) !== values['project-id']) throw new Error('Item is outside the declared proof project; no record emitted')
  items.push({ id: issue.id, key: issue.key, url: site.origin + '/browse/' + issue.key,
    projectId: issue.fields.project.id, http: result.status, availability: 'known',
    type: { id: issue.fields.issuetype.id, name: issue.fields.issuetype.name },
    status: { id: issue.fields.status.id, name: issue.fields.status.name },
    assigneeAccountId: issue.fields.assignee?.accountId ?? null,
    executionObservation: 'not-collected; native assignee/status is not worker evidence',
    descriptionHasContent: !!issue.fields.description?.content?.length,
    links: (issue.fields.issuelinks ?? []).map(link => ({ id: link.id, typeId: link.type.id,
      direction: link.inwardIssue ? 'inward' : 'outward',
      targetId: (link.inwardIssue ?? link.outwardIssue).id,
      targetStatusId: (link.inwardIssue ?? link.outwardIssue).fields?.status?.id ?? null })),
  })
}
console.log(JSON.stringify({ mode: 'live-read-only', observed_at: new Date().toISOString(),
  site: site.origin, projectId: values['project-id'], items,
  limits: 'Current fixture reads only. No Jira UI, notification delivery, Decision/Wait model, worker execution or full acceptance proved.' }, null, 2))
