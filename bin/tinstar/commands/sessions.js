// bin/tinstar/commands/sessions.js
import { httpJson } from '../http.js'
import { getApiBase } from '../../apiBase.js'

export function renderSessionList(state) {
  return (state.sessions || [])
    .map(session => `${session.name}\t${session.state || ''}\t${session.cliTemplate || ''}`)
    .join('\n')
}

export async function run(argv) {
  const baseUrl = getApiBase()
  const sub = argv[3]
  if (sub === 'list') {
    const state = await httpJson(`${baseUrl}/api/state`)
    const output = renderSessionList(state)
    if (output) console.log(output)
    return
  }
  if (sub === 'create') {
    const name = argv[4]
    const project = argv[5]
    const cliTemplate = argv[6] || 'claude-multi-agent'
    if (!name || !project) throw new Error('sessions create: name and project required')
    const res = await httpJson(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: { name, backend: 'tmux', project, cliTemplate },
    })
    if (res.ok === false) throw new Error(res.error?.message || 'create failed')
    console.log('ok')
    return
  }
  if (sub === 'stop') {
    const name = argv[4]
    if (!name) throw new Error('sessions stop: name required')
    const res = await httpJson(`${baseUrl}/api/sessions/${encodeURIComponent(name)}/stop`, { method: 'POST' })
    if (res.ok === false) throw new Error(res.error?.message || 'stop failed')
    console.log('ok')
    return
  }
  console.log('usage: tinstar sessions (list|create <name> <project> [template-id]|stop <name>)')
}
