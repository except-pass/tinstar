// bin/tinstar/status.js
import http from 'node:http'

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
  })
}

export async function gather(baseUrl) {
  const out = {
    backend: { ok: false, url: baseUrl },
    workspaces: 0, projects: [], sessions: 0, templates: [], onboarding: null,
  }
  let state
  try {
    state = await fetchJson(`${baseUrl}/api/state`)
    out.backend.ok = true
  } catch (e) {
    out.backend.error = e.message
    out.onboarding = 'connect'
    return out
  }
  try {
    const projectsResp = await fetchJson(`${baseUrl}/api/projects`)
    // /api/projects returns either a flat map or { ok, data: map } envelope; handle both.
    const map = projectsResp?.data && typeof projectsResp.data === 'object' ? projectsResp.data : projectsResp
    if (map && typeof map === 'object') out.projects = Object.keys(map)
  } catch { /* ignore */ }
  out.workspaces = (state.spaces || []).length
  out.sessions = (state.runs || []).length
  try {
    const tplResp = await fetchJson(`${baseUrl}/api/cli-templates`)
    const arr = tplResp?.data ?? tplResp ?? []
    out.templates = Array.isArray(arr) ? arr.map(t => t.name).filter(Boolean) : []
  } catch { /* ignore */ }
  if (out.workspaces === 0) out.onboarding = 'workspace'
  else if (out.projects.length === 0) out.onboarding = 'project'
  else if (out.sessions === 0) out.onboarding = 'first_session'
  else out.onboarding = null
  return out
}

export function renderStatus(snapshot, asJson) {
  if (asJson) return JSON.stringify(snapshot, null, 2)
  const b = snapshot.backend
  const lines = [
    `backend:    ${b.ok ? `ok (${b.url})` : `unreachable (${b.url}) - ${b.error}`}`,
    `workspaces: ${snapshot.workspaces}`,
    `projects:   ${snapshot.projects.length}${snapshot.projects.length ? ` (${snapshot.projects.join(', ')})` : ''}`,
    `sessions:   ${snapshot.sessions}`,
    `templates:  ${snapshot.templates.join(', ') || '(none)'}`,
    `onboarding: ${snapshot.onboarding ? `${snapshot.onboarding} step pending` : 'complete'}`,
  ]
  return lines.join('\n')
}

export async function run(argv) {
  const baseUrl = process.env.TINSTAR_API_BASE || 'http://localhost:5273'
  const asJson = argv.includes('--json')
  const snap = await gather(baseUrl)
  console.log(renderStatus(snap, asJson))
}
