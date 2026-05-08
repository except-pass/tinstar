import { httpJson } from '../http.js'

export async function run(argv) {
  const baseUrl = process.env.TINSTAR_API_BASE || 'http://localhost:5273'
  const spec = await httpJson(`${baseUrl}/api/docs/openapi.json`)
  const target = argv[4]
  if (!target) {
    console.log('API operations:\n')
    for (const [pathKey, ops] of Object.entries(spec.paths || {})) {
      for (const [method, op] of Object.entries(ops)) {
        console.log(`  ${method.toUpperCase().padEnd(6)} ${pathKey}\t${op.summary || ''}`)
      }
    }
    return
  }
  for (const [pathKey, ops] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      const idTokens = `${pathKey} ${op.operationId || ''}`.toLowerCase()
      if (idTokens.includes(target.toLowerCase())) {
        console.log(`${method.toUpperCase()} ${pathKey}`)
        if (op.summary) console.log(`  ${op.summary}`)
        if (op.requestBody) console.log('  body:', JSON.stringify(op.requestBody, null, 2))
        if (op.responses) console.log('  responses:', JSON.stringify(op.responses, null, 2))
        return
      }
    }
  }
  console.error(`no API operation matching: ${target}`)
  process.exit(1)
}
