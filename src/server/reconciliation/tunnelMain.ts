import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { getConfigRoot } from '../configRoot'
import { createTunnelFacade } from './tunnel'

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '5296' }, 'upstream-port': { type: 'string', default: '5281' },
  'caller-id': { type: 'string' }, 'caller-token-file': { type: 'string' },
  'allow-view': { type: 'boolean', default: false }, help: { type: 'boolean' },
} })
function privateCredential(path: string) {
  const info = statSync(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Credential must be owner-only')
  return readFileSync(path, 'utf8').trim()
}
async function main() {
  if (values.help) {
    console.log('Usage: tinstar-mcp-tunnel --caller-id NAME --caller-token-file FILE [--allow-view] [--port 5296] [--upstream-port 5281]\nBinds 127.0.0.1 only. TINSTAR_CONFIG_HOME selects the backend install token. Caller credential must be separate, at least 32 characters, owner-only, and configured in the calling client; never inject it with tunnel-client extra headers. Read tools only unless --allow-view is explicit.')
    return
  }
  const port = Number(values.port)
  if (!values['caller-id'] || !values['caller-token-file'] || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Explicit caller config and valid port required')
  const facade = createTunnelFacade({ upstreamPort: Number(values['upstream-port']),
    installToken: privateCredential(join(getConfigRoot(), 'mcp-token')),
    caller: { id: values['caller-id'], token: privateCredential(values['caller-token-file']), allowView: values['allow-view']! },
  })
  await facade.listen(port)
  console.log(`Tin Star MCP facade listening on 127.0.0.1:${port} (${values['allow-view'] ? 'read + view' : 'read only'})`)
}
main().catch(() => { console.error('Tin Star MCP facade failed; check private credential files, caller policy and loopback ports'); process.exitCode = 1 })
