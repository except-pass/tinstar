// bin/tinstar/commands/service.js — manage the tinstar systemd user unit
//
// Subcommands routed here:
//   tinstar install-service [--port N] [--host IP|--auto-host]
//   tinstar uninstall-service
//   tinstar start
//   tinstar stop
//   tinstar restart [--no-build]
//   tinstar logs    [--no-follow] [-n N]
//
// The unit lives at ~/.config/systemd/user/tinstar.service. Linger keeps it
// running across logouts. Repo path + build behavior are persisted to
// ~/.config/tinstar/service.json so `restart` can rebuild from the right tree
// even if invoked from elsewhere.

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, userInfo } from 'node:os'
import { getConfigRoot } from '../../configRoot.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const UNIT_NAME = 'tinstar.service'
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user')
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME)
const SERVICE_CONFIG_PATH = join(getConfigRoot(), 'service.json')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function shCapture(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim()
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts })
}

function flag(args, name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  return args[i + 1] ?? fallback
}

function detectTailscaleIp() {
  const ip = shCapture('/usr/bin/tailscale ip --4').split('\n')[0].trim()
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new Error(`tailscale ip --4 returned unexpected output: "${ip}"`)
  }
  return ip
}

function detectNodePath() {
  try {
    return shCapture('command -v node')
  } catch {
    return process.execPath
  }
}

// User-local bin dirs that are typically on an interactive shell's PATH but
// NOT on systemd's default PATH. We add the ones that exist to the unit's
// Environment=PATH so preflight checks (`claude --version` etc.) resolve.
function collectUserBinDirs() {
  const home = homedir()
  const candidates = [
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, 'bin'),
    join(home, '.cargo/bin'),
    '/usr/local/go/bin',
  ]
  // Also include the dir of `claude` if we can find it via the user's login
  // PATH — handles non-standard installs.
  try {
    const claudePath = shCapture('bash -lc "command -v claude"')
    if (claudePath) candidates.unshift(dirname(claudePath))
  } catch { /* claude not on login PATH — ensureClaudeOnPath will catch it */ }
  return candidates.filter(p => existsSync(p))
}

function ensureClaudeOnPath(extraPathDirs) {
  for (const dir of extraPathDirs) {
    if (existsSync(join(dir, 'claude'))) return
  }
  throw new Error(
    `claude binary not found in any of: ${extraPathDirs.join(', ')}\n` +
    `Install Claude Code first, or add its bin dir to one of those locations.`
  )
}

// Drop a symlink to bin/tinstar.js into ~/bin (already on the user's PATH on
// most setups) so `tinstar restart` etc. work without `node bin/tinstar.js`.
function installCliShim(repoRoot) {
  const userBin = join(homedir(), 'bin')
  if (!existsSync(userBin)) {
    console.log(`${DIM}~/bin missing — skipping CLI shim. Add ~/bin to PATH and re-run install.${RESET}`)
    return
  }
  const linkPath = join(userBin, 'tinstar')
  const targetPath = join(repoRoot, 'bin', 'tinstar.js')
  try {
    if (existsSync(linkPath) || (() => { try { lstatSync(linkPath); return true } catch { return false } })()) {
      const existing = lstatSync(linkPath)
      if (existing.isSymbolicLink() && readlinkSync(linkPath) === targetPath) {
        console.log(`${GREEN}✓${RESET} CLI shim already in place: ${linkPath}`)
        return
      }
      // Don't overwrite a non-symlink — could be a real script.
      if (!existing.isSymbolicLink()) {
        console.log(`${YELLOW}!${RESET} ${linkPath} exists and is not a symlink — leaving it alone`)
        return
      }
      unlinkSync(linkPath)
    }
    symlinkSync(targetPath, linkPath)
    console.log(`${GREEN}✓${RESET} installed CLI shim: ${linkPath} -> ${targetPath}`)
  } catch (err) {
    console.log(`${YELLOW}!${RESET} failed to install CLI shim at ${linkPath}: ${err.message}`)
  }
}

function buildUnit({ repoRoot, nodePath, port, corsOrigins, extraPathDirs }) {
  const nodeBinDir = dirname(nodePath)
  // PATH for the service. We include the user's local bin dirs (where `claude`
  // and friends typically live) plus standard system paths. Preflight checks
  // in bin/tinstar.js shell out to `claude --version` etc., so missing entries
  // here turn into instant crashloops.
  const pathEntries = [
    nodeBinDir,
    ...extraPathDirs,
    '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
  ]
  // De-dup while preserving order.
  const seen = new Set()
  const path = pathEntries.filter(p => p && !seen.has(p) && (seen.add(p), true)).join(':')
  // ExecStart resolves the tailscale IPv4 at start time so the unit keeps
  // working if the tailscale address changes (rare but free correctness).
  return `[Unit]
Description=Tinstar Agent Orchestrator
Documentation=https://github.com/anthropics/tinstar
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
Environment=NODE_ENV=production
Environment=TINSTAR_CORS_ORIGINS=${corsOrigins}
Environment=PATH=${path}
Environment=HOME=${homedir()}
ExecStart=/bin/bash -c 'exec "${nodePath}" "${repoRoot}/bin/tinstar.js" --port ${port} --no-open --no-setup --host $(/usr/bin/tailscale ip --4 | head -n1)'
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`
}

function readServiceConfig() {
  try { return JSON.parse(readFileSync(SERVICE_CONFIG_PATH, 'utf-8')) } catch { return null }
}

function writeServiceConfig(cfg) {
  mkdirSync(getConfigRoot(), { recursive: true })
  writeFileSync(SERVICE_CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

async function installService(args) {
  if (!existsSync('/usr/bin/tailscale')) {
    throw new Error('tailscale not found at /usr/bin/tailscale — install it first')
  }
  const port = parseInt(flag(args, '--port', '5273'))
  const repoRoot = REPO_ROOT
  const nodePath = detectNodePath()
  const tsIp = detectTailscaleIp()
  const extraPathDirs = collectUserBinDirs()
  const corsOrigins = [
    'tauri://localhost',
    'https://tauri.localhost',
    'http://tauri.localhost',
    `http://localhost:${port}`,
    `http://infrapoc:${port}`,
    `http://${tsIp}:${port}`,
  ].join(',')

  console.log(`${BOLD}Installing tinstar systemd user unit${RESET}\n`)
  console.log(`  ${DIM}Repo:${RESET}      ${repoRoot}`)
  console.log(`  ${DIM}Node:${RESET}      ${nodePath}`)
  console.log(`  ${DIM}Port:${RESET}      ${port}`)
  console.log(`  ${DIM}TS IPv4:${RESET}   ${tsIp} ${DIM}(re-resolved at every start)${RESET}`)
  console.log(`  ${DIM}Extra PATH:${RESET} ${extraPathDirs.join(':') || '(none)'}`)
  console.log(`  ${DIM}Unit path:${RESET} ${UNIT_PATH}\n`)

  // Sanity check: we need `claude` reachable from the unit, otherwise preflight
  // exits 1 and systemd will crashloop. Refuse the install rather than ship a
  // broken unit.
  ensureClaudeOnPath(extraPathDirs)

  mkdirSync(UNIT_DIR, { recursive: true })
  const unit = buildUnit({ repoRoot, nodePath, port, corsOrigins, extraPathDirs })
  writeFileSync(UNIT_PATH, unit)
  console.log(`${GREEN}✓${RESET} wrote ${UNIT_PATH}`)

  installCliShim(repoRoot)

  writeServiceConfig({ repoRoot, port, nodePath, installedAt: new Date().toISOString() })

  // Linger lets the user manager run when nobody is logged in.
  const username = userInfo().username
  let lingerOk = false
  try {
    const linger = shCapture(`loginctl show-user ${username} -p Linger --value 2>/dev/null`)
    lingerOk = linger === 'yes'
  } catch { /* user record may not exist yet */ }
  if (!lingerOk) {
    console.log(`${YELLOW}!${RESET} linger not enabled for ${username} — enabling (may prompt for sudo)`)
    sh(`sudo loginctl enable-linger ${username}`)
    console.log(`${GREEN}✓${RESET} linger enabled`)
  } else {
    console.log(`${GREEN}✓${RESET} linger already enabled for ${username}`)
  }

  sh(`systemctl --user daemon-reload`)

  // Warn if there's a running stale instance not under our unit so the user
  // isn't surprised when systemctl start kills it via the existing pidfile.
  try {
    const activeBefore = shCapture(`systemctl --user is-active ${UNIT_NAME} 2>/dev/null || true`)
    if (activeBefore !== 'active') {
      const stale = shCapture('pgrep -af "node .*bin/tinstar.js" || true')
      if (stale) {
        console.log(`${YELLOW}!${RESET} existing tinstar process(es) detected — they will be replaced:\n${DIM}${stale}${RESET}`)
      }
    }
  } catch { /* best effort */ }

  sh(`systemctl --user enable --now ${UNIT_NAME}`)

  console.log(`\n${GREEN}✓${RESET} ${BOLD}tinstar service installed and running${RESET}`)
  console.log(`${DIM}Reachable at: http://infrapoc:${port}${RESET}`)
  console.log(`${DIM}Restart with:  tinstar restart${RESET}`)
  console.log(`${DIM}Tail logs:     tinstar logs${RESET}`)
}

async function uninstallService() {
  try { sh(`systemctl --user disable --now ${UNIT_NAME}`) } catch { /* not installed */ }
  if (existsSync(UNIT_PATH)) {
    unlinkSync(UNIT_PATH)
    console.log(`${GREEN}✓${RESET} removed ${UNIT_PATH}`)
  }
  try { sh(`systemctl --user daemon-reload`) } catch { /* fine */ }
  try { unlinkSync(SERVICE_CONFIG_PATH) } catch { /* fine */ }
  // Remove the CLI shim if it points at our repo.
  const linkPath = join(homedir(), 'bin', 'tinstar')
  try {
    const st = lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      const target = readlinkSync(linkPath)
      if (target.startsWith(REPO_ROOT)) {
        unlinkSync(linkPath)
        console.log(`${GREEN}✓${RESET} removed CLI shim ${linkPath}`)
      }
    }
  } catch { /* not present */ }
  console.log(`${GREEN}✓${RESET} tinstar service uninstalled`)
}

function ensureInstalled() {
  if (!existsSync(UNIT_PATH)) {
    throw new Error(`unit not installed (${UNIT_PATH} missing). Run: tinstar install-service`)
  }
}

async function startService() {
  ensureInstalled()
  sh(`systemctl --user start ${UNIT_NAME}`)
  console.log(`${GREEN}✓${RESET} started`)
}

async function stopService() {
  ensureInstalled()
  sh(`systemctl --user stop ${UNIT_NAME}`)
  console.log(`${GREEN}✓${RESET} stopped`)
}

async function restartService(args) {
  ensureInstalled()
  const skipBuild = args.includes('--no-build')
  const cfg = readServiceConfig()
  const repoRoot = cfg?.repoRoot || REPO_ROOT
  if (!skipBuild) {
    console.log(`${DIM}rebuilding (npm run build:all in ${repoRoot})...${RESET}`)
    sh('npm run build:all', { cwd: repoRoot })
  }
  sh(`systemctl --user restart ${UNIT_NAME}`)
  console.log(`${GREEN}✓${RESET} restarted`)
}

async function logsService(args) {
  ensureInstalled()
  const follow = !args.includes('--no-follow')
  const nIdx = args.indexOf('-n')
  const n = nIdx !== -1 ? args[nIdx + 1] : '200'
  const cmd = follow
    ? `journalctl --user -u ${UNIT_NAME} -n ${n} -f`
    : `journalctl --user -u ${UNIT_NAME} -n ${n} --no-pager`
  spawnSync(cmd, { shell: true, stdio: 'inherit' })
}

export async function run(argv) {
  const sub = argv[2]
  const args = argv.slice(3)
  switch (sub) {
    case 'install-service':   return installService(args)
    case 'uninstall-service': return uninstallService()
    case 'start':             return startService()
    case 'stop':              return stopService()
    case 'restart':           return restartService(args)
    case 'logs':              return logsService(args)
    default:
      throw new Error(`unknown service subcommand: ${sub}`)
  }
}
