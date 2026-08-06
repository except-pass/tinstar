#!/usr/bin/env node
// bin/install-statusline.js — register Tinstar's cc-quota statusline hook with Claude Code.
//
// This is what makes the per-session **context meter** (and the quota HUD) work.
// Claude Code has no other push channel for context-window utilization: it pipes
// its full session-state JSON to the `statusLine` command on every render, and
// our shim POSTs that to `/api/cc-quota/ingest`. Without this hook registered,
// every Claude session's context meter reads `--` forever, silently.
//
// Two things get installed:
//   1. A copy of scripts/cc-quota-statusline.sh into the Tinstar config root.
//      We copy rather than point at the package directory because `npx tinstar`
//      runs from a volatile npm cache path — a settings.json entry pointing there
//      breaks the next time the cache is pruned.
//   2. A `statusLine` key in the harness settings.json (default ~/.claude).
//
// Usage:
//   tinstar install-statusline                    # ~/.claude
//   tinstar install-statusline --dest ./.claude   # project-local harness
//   tinstar install-statusline --port 5300        # non-default Tinstar port
//   tinstar install-statusline --force            # replace a foreign statusLine
//   tinstar install-statusline --dry-run          # show what would happen

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { getConfigRoot } from './configRoot.js'

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

export const DEFAULT_PORT = 5273
const SCRIPT_NAME = 'cc-quota-statusline.sh'

/** Absolute path of the script copy we install and point settings.json at. */
export function installedScriptPath() {
  return join(getConfigRoot(), SCRIPT_NAME)
}

/** Absolute path of the pristine script shipped inside the package/repo. */
export function sourceScriptPath() {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'scripts', SCRIPT_NAME)
}

/** Default harness settings.json — Claude Code's user-level config. */
export function defaultSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** POSIX-quote a path for embedding in the settings.json command string. */
function shellQuote(p) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** The exact `statusLine.command` string we want registered for a given port. */
export function expectedCommand(port = DEFAULT_PORT) {
  const script = shellQuote(installedScriptPath())
  if (port === DEFAULT_PORT) return script
  return `TINSTAR_INGEST_URL=http://127.0.0.1:${port}/api/cc-quota/ingest ${script}`
}

/** True when a settings.json command string refers to our shim (any port). */
function isOurs(command) {
  return typeof command === 'string' && command.includes(SCRIPT_NAME)
}

/**
 * Inspect the current install without touching anything.
 *
 * state:
 *   'ok'          — script present and settings.json points at it
 *   'drifted'     — ours, but the command string or script copy is out of date
 *   'foreign'     — a statusLine exists that isn't ours (needs --force)
 *   'missing'     — no statusLine registered
 *   'unreadable'  — settings.json exists but doesn't parse
 */
export function inspectStatusline({ settingsPath = defaultSettingsPath(), port = DEFAULT_PORT } = {}) {
  const scriptPath = installedScriptPath()
  const src = sourceScriptPath()
  const scriptInstalled = existsSync(scriptPath)
  const scriptCurrent = scriptInstalled && existsSync(src)
    ? readFileSync(scriptPath, 'utf-8') === readFileSync(src, 'utf-8')
    : scriptInstalled

  let settings = null
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch (err) {
      return { state: 'unreadable', settingsPath, scriptPath, error: err.message }
    }
  }

  const command = settings?.statusLine?.command
  const base = { settingsPath, scriptPath, command, scriptInstalled, scriptCurrent }

  if (!command) return { ...base, state: 'missing' }
  if (!isOurs(command)) return { ...base, state: 'foreign' }
  if (command !== expectedCommand(port) || !scriptInstalled || !scriptCurrent) {
    return { ...base, state: 'drifted' }
  }
  return { ...base, state: 'ok' }
}

function have(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' })
    return true
  } catch { return false }
}

/** The shim shells out to these on every render. Missing ones break it silently. */
export function missingShimDeps() {
  return ['jq', 'curl'].filter(c => !have(c))
}

/**
 * Do the install. Returns { code, state, changed, messages } — `code` 0 on success.
 * `quiet` suppresses stdout so callers (preflight, doctor) can render their own lines.
 */
export function runInstall({
  settingsPath = defaultSettingsPath(),
  port = DEFAULT_PORT,
  force = false,
  dryRun = false,
  quiet = false,
} = {}) {
  const messages = []
  const say = (msg) => { messages.push(msg); if (!quiet) console.log(msg) }

  const src = sourceScriptPath()
  if (!existsSync(src)) {
    say(`${RED}✗${RESET} statusline shim not found at ${src}`)
    return { code: 1, state: 'no-source', changed: false, messages }
  }

  const before = inspectStatusline({ settingsPath, port })

  if (before.state === 'unreadable') {
    say(`${RED}✗${RESET} ${settingsPath} is not valid JSON — fix it, then re-run.`)
    say(`  ${DIM}${before.error}${RESET}`)
    return { code: 1, state: 'unreadable', changed: false, messages }
  }

  if (before.state === 'foreign' && !force) {
    say(`${RED}✗${RESET} A different statusLine is already registered:`)
    say(`  ${DIM}${before.command}${RESET}`)
    say(`  Pass ${BOLD}--force${RESET} to replace it (the old value is backed up), or chain ours`)
    say(`  from your own script by piping stdin through ${DIM}${installedScriptPath()}${RESET}.`)
    return { code: 1, state: 'foreign', changed: false, messages }
  }

  if (before.state === 'ok') {
    say(`${GREEN}✓${RESET} statusline hook already installed ${DIM}(${settingsPath})${RESET}`)
    return { code: 0, state: 'ok', changed: false, messages }
  }

  const scriptPath = installedScriptPath()
  const command = expectedCommand(port)

  if (dryRun) {
    say(`${YELLOW}~${RESET} would copy ${DIM}${src}${RESET} → ${DIM}${scriptPath}${RESET}`)
    if (before.state === 'foreign') say(`${YELLOW}~${RESET} would back up ${DIM}${settingsPath}${RESET} → ${DIM}${settingsPath}.bak${RESET}`)
    say(`${YELLOW}~${RESET} would set statusLine.command → ${DIM}${command}${RESET}`)
    return { code: 0, state: before.state, changed: false, messages }
  }

  // 1. Install the script copy into the config root.
  try {
    mkdirSync(dirname(scriptPath), { recursive: true })
    copyFileSync(src, scriptPath)
    chmodSync(scriptPath, 0o755)
    say(`${GREEN}✓${RESET} shim installed ${DIM}${scriptPath}${RESET}`)
  } catch (err) {
    say(`${RED}✗${RESET} could not install shim: ${err.message}`)
    return { code: 1, state: before.state, changed: false, messages }
  }

  // 2. Merge statusLine into settings.json, preserving every other key.
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch (err) {
      say(`${RED}✗${RESET} ${settingsPath} became unreadable: ${err.message}`)
      return { code: 1, state: 'unreadable', changed: false, messages }
    }
    if (before.state === 'foreign') {
      try {
        copyFileSync(settingsPath, `${settingsPath}.bak`)
        say(`${YELLOW}~${RESET} previous settings backed up ${DIM}${settingsPath}.bak${RESET}`)
      } catch (err) {
        say(`${RED}✗${RESET} backup failed, refusing to overwrite: ${err.message}`)
        return { code: 1, state: 'foreign', changed: false, messages }
      }
    }
  }

  settings.statusLine = { type: 'command', command }

  // Atomic write — a half-written settings.json would break every Claude launch.
  try {
    mkdirSync(dirname(settingsPath), { recursive: true })
    const tmp = `${settingsPath}.tinstar-tmp`
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`)
    renameSync(tmp, settingsPath)
    say(`${GREEN}✓${RESET} statusLine registered ${DIM}${settingsPath}${RESET}`)
  } catch (err) {
    say(`${RED}✗${RESET} could not write ${settingsPath}: ${err.message}`)
    return { code: 1, state: before.state, changed: false, messages }
  }

  const missing = missingShimDeps()
  if (missing.length) {
    say(`${YELLOW}⚠${RESET} missing on PATH: ${missing.join(', ')} ${DIM}— the shim needs them; install and the meter starts filling${RESET}`)
  }

  say(`${DIM}Restart or start a Claude session — the context meter fills on its first render.${RESET}`)
  return { code: 0, state: 'ok', changed: true, messages }
}

function parseArgs(argv) {
  const args = { dest: null, port: DEFAULT_PORT, force: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dest' || a === '-d') args.dest = argv[++i]
    else if (a === '--port' || a === '-p') args.port = parseInt(argv[++i], 10)
    else if (a === '--force' || a === '-f') args.force = true
    else if (a === '--dry-run' || a === '-n') args.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: tinstar install-statusline [--dest <dir>] [--port <n>] [--force] [--dry-run]

Registers Tinstar's cc-quota statusline hook with Claude Code. This is what
feeds the per-session context-fullness meter and the quota HUD — without it,
every Claude session's context meter reads "--".

  --dest <dir>   Harness dir holding settings.json (default: ~/.claude).
                 Use ./.claude for a project-local harness.
  --port <n>     Tinstar server port, if not ${DEFAULT_PORT}.
  --force        Replace an existing non-Tinstar statusLine (backed up to
                 settings.json.bak).
  --dry-run      Print what would happen; don't write anything.
`)
      process.exit(0)
    } else {
      console.error(`${RED}Unknown argument: ${a}${RESET}`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    console.error(`${RED}--port must be a positive integer${RESET}`)
    process.exit(2)
  }
  return args
}

export async function installStatusline(argv = process.argv.slice(3)) {
  const args = parseArgs(argv)
  const settingsPath = args.dest
    ? join(resolve(expandHome(args.dest)), 'settings.json')
    : defaultSettingsPath()

  console.log(`${BOLD}Tinstar statusline install${RESET}`)
  const { code } = runInstall({ settingsPath, port: args.port, force: args.force, dryRun: args.dryRun })
  process.exit(code)
}

// Allow running directly: `node bin/install-statusline.js [...]`
if (import.meta.url === `file://${process.argv[1]}`) {
  installStatusline(process.argv.slice(2))
}
