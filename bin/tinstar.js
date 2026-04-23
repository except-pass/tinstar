#!/usr/bin/env node
// bin/tinstar.js — Tinstar CLI entry point

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

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

  // Project detection
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: process.cwd() }).trim()
    const projectName = basename(gitRoot)
    const projectsFile = join(homedir(), '.config', 'tinstar', 'projects.json')

    let projects = {}
    try { projects = JSON.parse(readFileSync(projectsFile, 'utf-8')) } catch {}

    if (!Object.values(projects).includes(gitRoot)) {
      const answer = await ask(`📁 Detected project: ${BOLD}${projectName}${RESET} (${gitRoot})\n   Add as a Tinstar project? [Y/n] `)
      if (answer !== 'n' && answer !== 'no') {
        mkdirSync(join(homedir(), '.config', 'tinstar'), { recursive: true })
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
  const { startServer } = await import('../dist/server/standalone.js')
  startServer({ port, clientDir: join(import.meta.dirname, '..', 'dist', 'client'), open: !noOpen })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
