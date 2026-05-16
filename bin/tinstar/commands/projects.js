// bin/tinstar/commands/projects.js
import { httpJson } from '../http.js'
import { getApiBase } from '../../apiBase.js'

export async function run(argv) {
  const baseUrl = getApiBase()
  const sub = argv[3]
  if (sub === 'list') {
    const resp = await httpJson(`${baseUrl}/api/projects`)
    const map = resp?.data && typeof resp.data === 'object' ? resp.data : resp
    if (map && typeof map === 'object') {
      for (const [name, path] of Object.entries(map)) console.log(`${name}\t${path}`)
    }
    return
  }
  if (sub === 'register') {
    const [name, path] = [argv[4], argv[5]]
    if (!name || !path) throw new Error('projects register: name and path required')
    const res = await httpJson(`${baseUrl}/api/projects`, { method: 'POST', body: { name, path } })
    if (res.ok === false) throw new Error(res.error?.message || 'register failed')
    console.log('ok')
    return
  }
  if (sub === 'unregister') {
    const name = argv[4]
    if (!name) throw new Error('projects unregister: name required')
    const res = await httpJson(`${baseUrl}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if (res.ok === false) throw new Error(res.error?.message || 'unregister failed')
    console.log('ok')
    return
  }
  console.log('usage: tinstar projects (list|register <name> <path>|unregister <name>)')
}
