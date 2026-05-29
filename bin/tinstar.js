#!/usr/bin/env node
// bin/tinstar.js — Tinstar CLI entry point

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { getConfigRoot } from './configRoot.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function check(label, fn) {
  try {
    const result = fn()
    console.log(`${GREEN}✓${RESET} ${label}${result ? ` ${DIM}(${result})${RESET}` : ''}`)
    return true
  } catch (err) {
    console.log(`${RED}✗${RESET} ${label}`)
    console.log(`  ${DIM}→ ${err.message}${RESET}`)
    return false
  }
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

// Every top-level subcommand the CLI dispatches. Anything else in the command
// position is a typo — we refuse it rather than silently starting the server.
const KNOWN_COMMANDS = [
  'doctor', 'install-skills', 'status',
  'install-service', 'uninstall-service', 'start', 'stop', 'restart', 'logs',
  'workspaces', 'projects', 'sessions', 'tasks', 'templates', 'help',
]

// Levenshtein edit distance — for "did you mean" suggestions on typos.
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

// Closest known command within a typo-sized distance, else null.
function suggestCommand(input) {
  let best = null
  let bestDistance = Infinity
  for (const cmd of KNOWN_COMMANDS) {
    const d = editDistance(input, cmd)
    if (d < bestDistance) {
      bestDistance = d
      best = cmd
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 3))
  return bestDistance <= threshold ? best : null
}

async function main() {
  // Subcommand: doctor
  if (process.argv[2] === 'doctor') {
    const { doctor } = await import('./doctor.js')
    return doctor()
  }

  // Subcommand: install-skills
  if (process.argv[2] === 'install-skills') {
    const { installSkills } = await import('./install-skills.js')
    return installSkills(process.argv.slice(3))
  }

  // Subcommand: status
  if (process.argv[2] === 'status') {
    const { run } = await import('./tinstar/status.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }

  // Service management — drives the systemd user unit
  const SERVICE_SUBCOMMANDS = new Set([
    'install-service', 'uninstall-service', 'start', 'stop', 'restart', 'logs',
  ])
  if (SERVICE_SUBCOMMANDS.has(process.argv[2])) {
    const { run } = await import('./tinstar/commands/service.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }

  if (process.argv[2] === 'workspaces') {
    const { run } = await import('./tinstar/commands/workspaces.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }
  if (process.argv[2] === 'projects') {
    const { run } = await import('./tinstar/commands/projects.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }
  if (process.argv[2] === 'sessions') {
    const { run } = await import('./tinstar/commands/sessions.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }
  if (process.argv[2] === 'tasks') {
    const { run } = await import('./tinstar/commands/tasks.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }
  if (process.argv[2] === 'templates') {
    const { run } = await import('./tinstar/commands/templates.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }

  if (process.argv[2] === 'help' && process.argv[3] === 'api') {
    const { run } = await import('./tinstar/commands/help-api.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }

  if (process.argv[2] === 'help' && process.argv[3] !== 'api') {
    const { run } = await import('./tinstar/help.js')
    return run(process.argv).catch(e => { console.error(e.message); process.exit(1) })
  }

  // Reject typos. Starting the server takes only flags (e.g. `tinstar --port 5273`)
  // or no args at all — never a positional. So a bare token in the command slot
  // that matched no subcommand above is a mistake, not a request to start.
  const command = process.argv[2]
  if (command !== undefined && !command.startsWith('-')) {
    console.error(`\n${RED}✗${RESET} Unknown command: ${BOLD}${command}${RESET}`)
    const guess = suggestCommand(command)
    if (guess) {
      console.error(`  ${DIM}Did you mean${RESET} ${BOLD}tinstar ${guess}${RESET}${DIM}?${RESET}`)
    }
    console.error(`\n  ${DIM}Run${RESET} tinstar help ${DIM}for available commands, or${RESET} tinstar ${DIM}(no args) to start the server.${RESET}\n`)
    process.exit(1)
  }

  console.log(`\n${BOLD}Tinstar${RESET} — Agent Orchestrator\n`)

  // Pre-flight checks
  let allPassed = true

  allPassed &= check('Claude Code installed', () => {
    const version = execSync('claude --version', { encoding: 'utf-8' }).trim()
    return `v${version}`
  })

  allPassed &= check('Claude authenticated', () => {
    const raw = execSync('claude auth status', { encoding: 'utf-8' }).trim()
    const status = JSON.parse(raw)
    if (!status.loggedIn) throw new Error('Run: claude auth login')
    return status.email
  })

  allPassed &= check('tmux installed', () => {
    execSync('which tmux', { encoding: 'utf-8' })
    return null
  })

  allPassed &= check('ttyd installed', () => {
    execSync('which ttyd', { encoding: 'utf-8' })
    return null
  })

  if (!allPassed) {
    console.log(`\n${DIM}Fix the issues above and re-run: npx tinstar${RESET}\n`)
    process.exit(1)
  }

  console.log()

  // Project detection — skip the prompt under --no-setup or when stdin isn't a TTY
  // (CI, pipes, here-strings). Non-TTY callers get the same effect as answering "n".
  const skipSetup = process.argv.includes('--no-setup') || !process.stdin.isTTY
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: process.cwd() }).trim()
    const projectName = basename(gitRoot)
    const projectsFile = join(getConfigRoot(), 'projects.json')

    let projects = {}
    try { projects = JSON.parse(readFileSync(projectsFile, 'utf-8')) } catch {}

    if (!Object.values(projects).includes(gitRoot) && !skipSetup) {
      const answer = await ask(`📁 Detected project: ${BOLD}${projectName}${RESET} (${gitRoot})\n   Add as a Tinstar project? [Y/n] `)
      if (answer !== 'n' && answer !== 'no') {
        mkdirSync(getConfigRoot(), { recursive: true })
        projects[projectName] = gitRoot
        writeFileSync(projectsFile, JSON.stringify(projects, null, 2))
        console.log(`${GREEN}✓${RESET} Added ${projectName}\n`)
      } else {
        console.log()
      }
    }
  } catch {
    // Not a git repo — skip silently
  }

  // Start server
  const noOpen = process.argv.includes('--no-open')
  const portIdx = process.argv.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1]) : 5273
  // Collect repeated --host flags and/or a comma-separated list.
  const hosts = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--host' && process.argv[i + 1]) {
      hosts.push(...process.argv[i + 1].split(',').map(s => s.trim()).filter(Boolean))
      i++
    }
  }
  if (hosts.length === 0 && process.env.TINSTAR_HOST) {
    hosts.push(...process.env.TINSTAR_HOST.split(',').map(s => s.trim()).filter(Boolean))
  }
  const { startServer } = await import('../dist/server/standalone.js')
  startServer({ port, host: hosts, clientDir: join(import.meta.dirname, '..', 'dist', 'client'), open: !noOpen })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
