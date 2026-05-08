// bin/tinstar/commands/workspaces.js
import { httpJson } from '../http.js'

export async function run(argv) {
  const baseUrl = process.env.TINSTAR_API_BASE || 'http://localhost:5273'
  const sub = argv[3]
  if (sub === 'list') {
    const state = await httpJson(`${baseUrl}/api/state`)
    for (const s of state.spaces || []) {
      console.log(`${s.id}\t${s.name || ''}`)
    }
    return
  }
  if (sub === 'create') {
    const name = argv[4]
    if (!name) throw new Error('workspaces create: name required')
    const res = await httpJson(`${baseUrl}/api/spaces`, { method: 'POST', body: { name } })
    if (!res.ok && res.id) console.log(res.id)
    else if (res.ok === false) throw new Error(res.error?.message || 'create failed')
    else console.log(res.id || 'ok')
    return
  }
  if (sub === 'delete') {
    const id = argv[4]
    if (!id) throw new Error('workspaces delete: id required')
    const res = await httpJson(`${baseUrl}/api/spaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok === false) throw new Error(res.error?.message || 'delete failed')
    console.log('ok')
    return
  }
  console.log('usage: tinstar workspaces (list|create <name>|delete <id>)')
}
