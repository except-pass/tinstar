#!/usr/bin/env node
import { join } from 'node:path'

const commands = new Set([
  'doctor', 'install-statusline', 'status', 'reach',
  'install-service', 'uninstall-service', 'start', 'stop', 'restart', 'logs', 'help',
])

async function main() {
  const command = process.argv[2]
  if (command && !command.startsWith('-')) {
    if (!commands.has(command)) {
      console.error(`Unknown command: ${command}`)
      process.exitCode = 1
      return
    }
    if (command === 'help') {
      console.log('Usage: tinstar [--port PORT] [--host ADDRESS] [--no-open] [--no-reach]')
      console.log('Commands: doctor, install-statusline, status, reach, install-service, uninstall-service, start, stop, restart, logs')
      return
    }
    if (command === 'doctor') return (await import('./doctor.js')).doctor()
    if (command === 'install-statusline') return (await import('./install-statusline.js')).installStatusline(process.argv.slice(3))
    if (command === 'status') return (await import('./tinstar/status.js')).run(process.argv)
    if (command === 'reach') return (await import('./tinstar/commands/reach.js')).run(process.argv.slice(3))
    return (await import('./tinstar/commands/service.js')).run(process.argv)
  }

  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const port = portIdx === -1 ? 5273 : Number(args[portIdx + 1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port')
  const hosts = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) {
      hosts.push(...args[i + 1].split(',').map(s => s.trim()).filter(Boolean))
      i++
    }
  }
  if (!hosts.length && process.env.TINSTAR_HOST) hosts.push(...process.env.TINSTAR_HOST.split(',').map(s => s.trim()).filter(Boolean))
  const { startServer } = await import('../dist/server/standalone.js')
  startServer({
    port, host: hosts, clientDir: join(import.meta.dirname, '..', 'dist', 'client'),
    open: !args.includes('--no-open'), force: args.includes('--force'),
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
