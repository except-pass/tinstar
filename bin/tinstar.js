#!/usr/bin/env node
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const GREEN = '\x1b[32m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

// Offer to register the cc-quota statusline hook with Claude Code. Non-fatal in
// every branch: a declined or failed install still starts the server, it just
// leaves the quota meter dark — and says so, rather than failing silently.
async function setupStatusline(port, skipSetup) {
  const mod = await import('./install-statusline.js')

  let state
  try {
    state = mod.inspectStatusline({ port }).state
  } catch {
    return
  }

  if (state === 'ok') {
    console.log(`${GREEN}✓${RESET} Claude statusline hook registered ${DIM}(quota meter live)${RESET}`)
    const missing = mod.missingShimDeps()
    if (missing.length) {
      console.log(`  ${DIM}→ but ${missing.join(' and ')} missing from PATH — the shim needs them${RESET}`)
    }
    console.log()
    return
  }

  const label = {
    missing: 'not registered yet',
    drifted: 'out of date',
    foreign: 'a different statusLine is registered',
    unreadable: '~/.claude/settings.json is not valid JSON',
  }[state] ?? state

  console.log(`📊 Claude statusline hook — ${BOLD}${label}${RESET}`)
  console.log(`   ${DIM}Powers the Claude quota meter.${RESET}`)

  if (state === 'unreadable') {
    console.log(`   ${DIM}Fix the file, then run: tinstar install-statusline${RESET}\n`)
    return
  }

  if (skipSetup) {
    console.log(`   ${DIM}Install it with: tinstar install-statusline${state === 'foreign' ? ' --force' : ''}${RESET}\n`)
    return
  }

  const prompt = state === 'foreign'
    ? `   Replace it with Tinstar's? Your current one is backed up. [y/N] `
    : `   Install it now? [Y/n] `
  const answer = await ask(prompt)
  const yes = state === 'foreign'
    ? answer === 'y' || answer === 'yes'
    : answer !== 'n' && answer !== 'no'

  if (!yes) {
    console.log(`   ${DIM}Skipped — the Claude quota meter stays unobserved. Run tinstar install-statusline later.${RESET}\n`)
    return
  }

  mod.runInstall({ port, force: state === 'foreign' })
  console.log()
}

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
      console.log('Usage: tinstar [--port PORT] [--host ADDRESS] [--no-open] [--no-setup] [--no-reach]')
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
  await setupStatusline(port, args.includes('--no-setup') || !process.stdin.isTTY)
  const { startServer } = await import('../dist/server/standalone.js')
  startServer({
    port, host: hosts, clientDir: join(import.meta.dirname, '..', 'dist', 'client'),
    open: !args.includes('--no-open'), force: args.includes('--force'),
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
