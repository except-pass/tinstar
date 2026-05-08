// bin/tinstar/commands/templates.js
import { httpJson } from '../http.js'

export async function run(argv) {
  const baseUrl = process.env.TINSTAR_API_BASE || 'http://localhost:5273'
  const sub = argv[3]
  if (sub === 'list') {
    const resp = await httpJson(`${baseUrl}/api/cli-templates`)
    const arr = resp?.data ?? resp ?? []
    if (Array.isArray(arr)) {
      for (const t of arr) console.log(`${t.name}\t${t.cmd || ''}`)
    }
    return
  }
  console.log('usage: tinstar templates list')
}
