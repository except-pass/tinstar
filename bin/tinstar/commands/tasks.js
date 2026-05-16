// bin/tinstar/commands/tasks.js
import { httpJson } from '../http.js'
import { getApiBase } from '../../apiBase.js'

export async function run(argv) {
  const baseUrl = getApiBase()
  const sub = argv[3]
  if (sub === 'list') {
    const state = await httpJson(`${baseUrl}/api/state`)
    for (const t of state.tasks || []) console.log(`${t.id}\t${t.title || ''}`)
    return
  }
  if (sub === 'create') {
    const title = argv[4]
    const epicId = argv[5]
    if (!title) throw new Error('tasks create: title required')
    const res = await httpJson(`${baseUrl}/api/tasks`, {
      method: 'POST',
      body: { title, epicId: epicId || null },
    })
    if (res.ok === false) throw new Error(res.error?.message || 'create failed')
    console.log(res.id || 'ok')
    return
  }
  console.log('usage: tinstar tasks (list|create <title> [epicId])')
}
