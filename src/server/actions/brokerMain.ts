import { readFile, stat } from 'node:fs/promises'
import { brokerConfigSchema } from './liveProvider'
import { listenBroker } from './brokerService'

async function main() {
  const path = process.env.TINSTAR_ACTION_BROKER_CONFIG || '/etc/tinstar-action-broker/config.json'
  const file = await stat(path)
  if (file.mode & 0o022) throw new Error('Broker config must not be writable by group or others')
  const config = brokerConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  await listenBroker(config)
}
void main().catch(() => { console.error('Action broker not provisioned or could not start. Verify dedicated identity, private config, staged runtime and unused Unix socket.'); process.exitCode = 1 })
