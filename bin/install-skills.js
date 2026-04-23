#!/usr/bin/env node
// bin/install-skills.js — symlink Tinstar's agent skills and commands into an agent-harness dir.
// Targets any harness that reads `skills/` + `commands/` subdirectories (Claude Code's ~/.claude,
// project-local .claude, .agents, etc.). Files are harness-portable markdown.
//
// Usage:
//   tinstar install-skills                 # installs to ~/.claude (default)
//   tinstar install-skills --dest ./.claude
//   tinstar install-skills --dest ./.agents
//   tinstar install-skills --force         # replace conflicts (moves existing to .bak)
//   tinstar install-skills --copy          # copy instead of symlink (for clone-and-forget setups)
//   tinstar install-skills --dry-run       # show what would happen without doing it

import { existsSync, readdirSync, statSync, symlinkSync, unlinkSync, renameSync, mkdirSync, lstatSync, readlinkSync, cpSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function parseArgs(argv) {
  const args = { dest: null, force: false, copy: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dest' || a === '-d') args.dest = argv[++i]
    else if (a === '--force' || a === '-f') args.force = true
    else if (a === '--copy') args.copy = true
    else if (a === '--dry-run' || a === '-n') args.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: tinstar install-skills [--dest <dir>] [--force] [--copy] [--dry-run]

Installs Tinstar's agent skills and slash commands into an agent-harness
directory with skills/ and commands/ subdirectories (default: ~/.claude).

  --dest <dir>   Target directory. Must contain or accept skills/ + commands/
                 subdirectories. Common values: ~/.claude, ./.claude, ./.agents
  --force        Move existing conflicting files to <path>.bak before linking.
  --copy         Copy files instead of symlinking. Default is symlink so repo
                 edits go live immediately.
  --dry-run      Print what would happen; don't write anything.
`)
      process.exit(0)
    } else {
      console.error(`${RED}Unknown argument: ${a}${RESET}`)
      process.exit(2)
    }
  }
  return args
}

function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function log(prefix, color, msg) {
  console.log(`${color}${prefix}${RESET} ${msg}`)
}

// Returns 'missing' | 'correct-symlink' | 'other-symlink' | 'file' | 'dir'
function inspect(path, wantTarget) {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { kind: 'missing' }
  }
  if (st.isSymbolicLink()) {
    const current = readlinkSync(path)
    const absCurrent = resolve(dirname(path), current)
    return { kind: absCurrent === wantTarget ? 'correct-symlink' : 'other-symlink', current }
  }
  if (st.isDirectory()) return { kind: 'dir' }
  return { kind: 'file' }
}

function install({ srcRoot, destRoot, force, copy, dryRun }) {
  const plan = []

  for (const kind of ['skills', 'commands']) {
    const srcKindDir = join(srcRoot, kind)
    if (!existsSync(srcKindDir)) continue
    const destKindDir = join(destRoot, kind)

    for (const entry of readdirSync(srcKindDir)) {
      const srcPath = resolve(srcKindDir, entry)
      const destPath = join(destKindDir, entry)
      plan.push({ srcPath, destPath, parent: destKindDir })
    }
  }

  if (plan.length === 0) {
    log('!', YELLOW, `No skills or commands found under ${srcRoot}`)
    return 1
  }

  console.log(`${BOLD}Tinstar skill install${RESET}`)
  console.log(`  from: ${DIM}${srcRoot}${RESET}`)
  console.log(`  to:   ${DIM}${destRoot}${RESET}`)
  console.log(`  mode: ${copy ? 'copy' : 'symlink'}${force ? ' (force)' : ''}${dryRun ? ' (dry-run)' : ''}`)
  console.log()

  let installed = 0
  let skipped = 0
  let failed = 0

  for (const { srcPath, destPath, parent } of plan) {
    const rel = relative(destRoot, destPath)
    const state = inspect(destPath, srcPath)

    if (state.kind === 'correct-symlink' && !copy) {
      log('=', DIM, `${rel} ${DIM}(already linked)${RESET}`)
      skipped++
      continue
    }

    if (state.kind !== 'missing') {
      if (!force) {
        log('✗', RED, `${rel} — exists (${state.kind}${state.current ? ` → ${state.current}` : ''}). Pass --force to replace.`)
        failed++
        continue
      }
      const backup = `${destPath}.bak`
      if (dryRun) {
        log('~', YELLOW, `${rel} → would back up to ${backup}`)
      } else {
        try {
          renameSync(destPath, backup)
          log('~', YELLOW, `${rel} backed up → ${DIM}${backup}${RESET}`)
        } catch (err) {
          log('✗', RED, `${rel} — backup failed: ${err.message}`)
          failed++
          continue
        }
      }
    }

    if (dryRun) {
      log('+', GREEN, `${rel} ${DIM}(would ${copy ? 'copy' : 'link'})${RESET}`)
      installed++
      continue
    }

    try {
      mkdirSync(parent, { recursive: true })
      if (copy) {
        cpSync(srcPath, destPath, { recursive: true })
      } else {
        symlinkSync(srcPath, destPath)
      }
      log('+', GREEN, rel)
      installed++
    } catch (err) {
      log('✗', RED, `${rel} — ${err.message}`)
      failed++
    }
  }

  console.log()
  console.log(`${BOLD}Summary:${RESET} ${GREEN}${installed} installed${RESET}, ${DIM}${skipped} already linked${RESET}${failed ? `, ${RED}${failed} failed${RESET}` : ''}`)
  return failed === 0 ? 0 : 1
}

export async function installSkills(argv = process.argv.slice(3)) {
  const args = parseArgs(argv)
  const dest = resolve(expandHome(args.dest ?? join(homedir(), '.claude')))

  // Source lives next to this script: ../agent-skills
  const here = dirname(fileURLToPath(import.meta.url))
  const srcRoot = resolve(here, '..', 'agent-skills')

  if (!existsSync(srcRoot)) {
    console.error(`${RED}Source skills directory not found: ${srcRoot}${RESET}`)
    process.exit(1)
  }

  const code = install({
    srcRoot,
    destRoot: dest,
    force: args.force,
    copy: args.copy,
    dryRun: args.dryRun,
  })
  process.exit(code)
}

// Allow running directly: `node bin/install-skills.js [...]`
if (import.meta.url === `file://${process.argv[1]}`) {
  installSkills(process.argv.slice(2))
}
