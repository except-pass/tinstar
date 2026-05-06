#!/usr/bin/env node
// bin/doctor.js — `tinstar doctor` diagnostic command

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { getConfigRoot } from './configRoot.js'

// ── Formatting ──

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const SYM = { pass: `${GREEN}✓${RESET}`, fail: `${RED}✗${RESET}`, warn: `${YELLOW}⚠${RESET}`, skip: `${DIM}⊘${RESET}` }

function printSection(name) {
  console.log(`\n${BOLD}${name}${RESET}`)
}

function printCheck({ status, label, detail }) {
  const sym = SYM[status]
  const detailStr = detail ? ` ${DIM}${detail}${RESET}` : ''
  console.log(`  ${sym} ${label}${detailStr}`)
}

// ── Check helpers ──

function cmdVersion(cmd, args = ['--version']) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf-8', timeout: 5000 }).stdout.trim()
  } catch { return null }
}

function cmdExists(cmd) {
  try {
    execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: 'pipe' })
    return true
  } catch { return false }
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = httpRequest({ hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname + urlObj.search, timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

function wsUpgradeCheck(host, port, path = '/ws', timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: host,
      port,
      path,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': Buffer.from(Math.random().toString()).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
      timeout: timeoutMs,
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve(true)
    })
    req.on('response', (res) => {
      // If we get a normal HTTP response instead of upgrade, WS failed
      reject(new Error(`HTTP ${res.statusCode} instead of 101 upgrade`))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

function sseCheck(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = httpRequest({ hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let gotSnapshot = false
      res.on('data', chunk => {
        if (chunk.toString().includes('event: snapshot')) {
          gotSnapshot = true
          res.destroy()
          resolve(true)
        }
      })
      res.on('end', () => {
        if (!gotSnapshot) reject(new Error('no snapshot event received'))
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

// ── Config paths ──

const ROOT = getConfigRoot()
const DOCSTORE = join(ROOT, 'docstore.json')
const CONFIG_FILE = join(ROOT, 'config.json')
const SESSIONS_DIR = join(ROOT, 'sessions')
const PORT_FILE = join(ROOT, 'server.port')

// ── Main ──

async function doctor() {
  console.log(`\n${BOLD}Tinstar Doctor${RESET}`)
  const issues = []

  // ────── System ──────
  printSection('System')

  const sysChecks = [
    (() => {
      const v = cmdVersion('tmux', ['-V'])
      if (!v) return { status: 'fail', label: 'tmux — not found', detail: 'tmux sessions will not work' }
      return { status: 'pass', label: `tmux ${v}` }
    })(),
    (() => {
      const out = cmdExists('ttyd')
      if (!out) return { status: 'fail', label: 'ttyd — not found', detail: 'terminals will not render' }
      const v = cmdVersion('ttyd', ['--version']) || ''
      return { status: 'pass', label: `ttyd${v ? ' ' + v : ''}` }
    })(),
    (() => {
      const out = cmdExists('expect')
      if (!out) return { status: 'warn', label: 'expect — not installed', detail: 'multi-agent NATS prompts require manual accept' }
      const v = cmdVersion('expect', ['-v']) || ''
      return { status: 'pass', label: `expect${v ? ' ' + v.replace('expect version ', '') : ''}` }
    })(),
    (() => {
      const v = cmdVersion('docker', ['--version'])
      if (!v) return { status: 'warn', label: 'docker — not installed', detail: 'docker sessions unavailable' }
      return { status: 'pass', label: v.replace('Docker version ', 'docker ').replace(/,.*/, '') }
    })(),
    (() => {
      const v = cmdVersion('git', ['--version'])
      if (!v) return { status: 'fail', label: 'git — not found', detail: 'commit tracking broken' }
      return { status: 'pass', label: v }
    })(),
    (() => {
      try {
        const v = execSync('claude --version', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim()
        try {
          const raw = execSync('claude auth status', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim()
          const status = JSON.parse(raw)
          if (!status.loggedIn) return { status: 'fail', label: `claude ${v} — not authenticated`, detail: 'run: claude auth login' }
          return { status: 'pass', label: `claude ${v} authenticated`, detail: status.email }
        } catch {
          return { status: 'warn', label: `claude ${v} — auth check failed` }
        }
      } catch {
        return { status: 'fail', label: 'claude — not found', detail: 'agent sessions will not start' }
      }
    })(),
  ]
  for (const c of sysChecks) {
    printCheck(c)
    if (c.status === 'fail') issues.push(c)
  }

  // ────── Config ──────
  printSection('Config')

  const configChecks = []

  if (!existsSync(ROOT)) {
    const c = { status: 'fail', label: `${ROOT} — missing`, detail: 'run tinstar once to initialize' }
    configChecks.push(c)
  } else {
    configChecks.push({ status: 'pass', label: `${ROOT} exists` })
  }

  // config.json
  if (existsSync(CONFIG_FILE)) {
    try {
      JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      configChecks.push({ status: 'pass', label: 'config.json valid' })
    } catch (err) {
      configChecks.push({ status: 'fail', label: 'config.json — parse error', detail: err.message })
    }
  } else {
    configChecks.push({ status: 'pass', label: 'config.json — absent (using defaults)' })
  }

  // port range
  let portStart = 8681
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    if (cfg.ports?.hostStart) portStart = cfg.ports.hostStart
  } catch {}
  const portEnd = portStart + 99
  configChecks.push({ status: 'pass', label: `port range ${portStart}–${portEnd} (100 slots)` })

  // sessions dir
  if (existsSync(SESSIONS_DIR)) {
    try {
      const count = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).length
      configChecks.push({ status: 'pass', label: `sessions dir: ${count} session${count !== 1 ? 's' : ''}` })
    } catch (err) {
      configChecks.push({ status: 'fail', label: 'sessions dir — unreadable', detail: err.message })
    }
  } else {
    configChecks.push({ status: 'warn', label: 'sessions dir — missing', detail: 'no sessions created yet' })
  }

  for (const c of configChecks) {
    printCheck(c)
    if (c.status === 'fail') issues.push(c)
  }

  // ────── Server ──────
  printSection('Server')

  let serverPort = null
  let serverState = null

  // Discover server port
  if (existsSync(PORT_FILE)) {
    try {
      serverPort = parseInt(readFileSync(PORT_FILE, 'utf-8').trim())
    } catch {}
  }
  if (!serverPort) {
    // Scan process list for tinstar
    try {
      const ps = execSync("ps aux | grep '[t]instar' | grep -v doctor", { encoding: 'utf-8', stdio: 'pipe' })
      const portMatch = ps.match(/--port\s+(\d+)/)
      if (portMatch) serverPort = parseInt(portMatch[1])
    } catch {}
  }
  if (!serverPort) serverPort = 5273

  // Try connecting
  try {
    const resp = await httpGet(`http://localhost:${serverPort}/api/state`)
    serverState = JSON.parse(resp.body)
    const runs = serverState.runs?.length ?? 0
    const inits = serverState.initiatives?.length ?? 0
    const epics = serverState.epics?.length ?? 0
    const tasks = serverState.tasks?.length ?? 0
    printCheck({ status: 'pass', label: `API responds on :${serverPort}`, detail: `${runs} runs, ${inits} initiatives, ${epics} epics, ${tasks} tasks` })
  } catch {
    printCheck({ status: 'skip', label: `server not reachable on :${serverPort}`, detail: 'skipping live checks' })
  }

  if (serverState) {
    // SSE check
    try {
      await sseCheck(`http://localhost:${serverPort}/api/events`)
      printCheck({ status: 'pass', label: 'SSE connects and sends snapshot' })
    } catch (err) {
      const c = { status: 'fail', label: 'SSE connection failed', detail: err.message }
      printCheck(c)
      issues.push(c)
    }

    // Active space
    const space = serverState.spaces?.find(s => s.id === serverState.activeSpaceId)
    if (space) {
      printCheck({ status: 'pass', label: `active space: "${space.name}"`, detail: space.id })
    } else if (serverState.activeSpaceId) {
      const c = { status: 'fail', label: `active space ${serverState.activeSpaceId} — not found in spaces list` }
      printCheck(c)
      issues.push(c)
    } else {
      const c = { status: 'fail', label: 'no active space set', detail: 'UI will show "No space selected"' }
      printCheck(c)
      issues.push(c)
    }
  }

  // ────── Persistence ──────
  printSection('Persistence')

  let docstoreData = null
  if (existsSync(DOCSTORE)) {
    try {
      const raw = readFileSync(DOCSTORE, 'utf-8')
      docstoreData = JSON.parse(raw)
      const size = (Buffer.byteLength(raw) / 1024).toFixed(0)
      printCheck({ status: 'pass', label: `docstore.json — ${size}KB, parseable` })
    } catch (err) {
      const c = { status: 'fail', label: 'docstore.json — corrupt', detail: err.message }
      printCheck(c)
      issues.push(c)
    }
  } else {
    printCheck({ status: 'warn', label: 'docstore.json — not found', detail: 'server will start with empty state' })
  }

  // Orphan runs
  if (docstoreData?.runs) {
    const runs = Array.isArray(docstoreData.runs) ? docstoreData.runs : Object.values(docstoreData.runs)
    let orphanCount = 0
    for (const run of runs) {
      const sessionName = run.sessionId || run.id
      if (!sessionName) continue
      // Skip simulator runs
      if (run.id?.startsWith('R-')) continue
      const sessDir = join(SESSIONS_DIR, sessionName)
      if (!existsSync(sessDir)) {
        const c = { status: 'fail', label: `orphan run "${sessionName}"`, detail: 'session dir missing — phantom widget in UI' }
        printCheck(c)
        issues.push(c)
        orphanCount++
      }
    }
    if (orphanCount === 0) {
      printCheck({ status: 'pass', label: 'no orphan runs' })
    }
  }

  // Stuck .deleting markers
  if (existsSync(SESSIONS_DIR)) {
    let stuckCount = 0
    for (const entry of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(SESSIONS_DIR, entry.name, '.deleting'))) {
        const c = { status: 'warn', label: `"${entry.name}" stuck in .deleting`, detail: 'remove dir manually or restart server' }
        printCheck(c)
        issues.push(c)
        stuckCount++
      }
    }
    if (stuckCount === 0) {
      printCheck({ status: 'pass', label: 'no stuck .deleting markers' })
    }
  }

  // ────── Sessions ──────
  printSection('Sessions')

  if (!existsSync(SESSIONS_DIR)) {
    printCheck({ status: 'skip', label: 'no sessions dir' })
  } else {
    const sessionDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && !existsSync(join(SESSIONS_DIR, d.name, '.deleting')))

    if (sessionDirs.length === 0) {
      printCheck({ status: 'skip', label: 'no sessions found' })
    }

    // Build port map from docstore
    const portMap = new Map()
    if (docstoreData?.runs) {
      const runs = Array.isArray(docstoreData.runs) ? docstoreData.runs : Object.values(docstoreData.runs)
      for (const run of runs) {
        if (run.port && run.sessionId) portMap.set(run.sessionId, run.port)
        if (run.port && run.id) portMap.set(run.id, run.port)
      }
    }
    // Also check live state for most up-to-date ports
    if (serverState?.runs) {
      for (const run of serverState.runs) {
        if (run.port && run.sessionId) portMap.set(run.sessionId, run.port)
        if (run.port && run.id) portMap.set(run.id, run.port)
      }
    }

    // Determine backend type from session state file
    function readSessionBackend(name) {
      try {
        const stateFile = join(SESSIONS_DIR, name, 'state.json')
        if (existsSync(stateFile)) {
          const data = JSON.parse(readFileSync(stateFile, 'utf-8'))
          return data.backend || 'tmux'
        }
      } catch {}
      return 'tmux'
    }

    const tmuxPrefix = 'tinstar-'

    for (const entry of sessionDirs) {
      const name = entry.name
      const backend = readSessionBackend(name)
      const port = portMap.get(name)
      const parts = []
      let hasFail = false

      // Backend alive check
      if (backend === 'docker') {
        const r = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', `${tmuxPrefix}${name}`], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
        if (r.status === 0 && r.stdout.trim() === 'running') {
          parts.push('docker alive')
        } else {
          parts.push(`${RED}docker dead${RESET}`)
          hasFail = true
        }
      } else {
        const r = spawnSync('tmux', ['has-session', '-t', `${tmuxPrefix}${name}`], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
        if (r.status === 0) {
          parts.push('tmux alive')
        } else {
          parts.push(`${RED}tmux dead${RESET}`)
          hasFail = true
        }
      }

      // ttyd checks (only if we know the port)
      if (port) {
        parts.push(`ttyd :${port}`)

        // HTTP check
        try {
          const resp = await httpGet(`http://localhost:${port}/`)
          if (resp.status === 200) {
            parts.push(`${GREEN}✓${RESET}http`)
          } else {
            parts.push(`${RED}✗${RESET}http(${resp.status})`)
            hasFail = true
          }
        } catch {
          parts.push(`${RED}✗${RESET}http`)
          hasFail = true
        }

        // WebSocket upgrade check
        try {
          await wsUpgradeCheck('localhost', port, '/ws')
          parts.push(`${GREEN}✓${RESET}ws`)
        } catch {
          parts.push(`${RED}✗${RESET}ws`)
          hasFail = true
        }

        // Proxy check (only if server is up)
        if (serverState) {
          try {
            const resp = await httpGet(`http://localhost:${serverPort}/s/${name}/`)
            if (resp.status === 200) {
              parts.push(`${GREEN}✓${RESET}proxy`)
            } else {
              parts.push(`${RED}✗${RESET}proxy(${resp.status})`)
              hasFail = true
            }
          } catch {
            parts.push(`${RED}✗${RESET}proxy`)
            hasFail = true
          }
        }
      } else {
        parts.push(`${YELLOW}no port${RESET}`)
      }

      const check = {
        status: hasFail ? 'fail' : 'pass',
        label: `${name} — ${parts.join(', ')}`,
      }
      printCheck(check)
      if (hasFail) {
        issues.push({ status: 'fail', label: `${name} — terminal chain broken`, detail: parts.filter(p => p.includes('✗') || p.includes('dead')).join(', ') })
      }
    }
  }

  // ────── Skills ──────
  printSection('Skills')

  const commitSkillPath = join(homedir(), '.claude', 'commands', 'tinstar-commit.md')
  if (existsSync(commitSkillPath)) {
    printCheck({ status: 'pass', label: 'tinstar-commit installed' })
  } else {
    const c = { status: 'warn', label: 'tinstar-commit not installed', detail: `expected at ${commitSkillPath}` }
    printCheck(c)
    issues.push(c)
  }

  // Skill discovery count
  let skillCount = 0
  const skillPaths = [
    join(homedir(), '.claude', 'commands'),
    join(homedir(), '.claude', 'skills'),
  ]
  for (const sp of skillPaths) {
    if (!existsSync(sp)) continue
    try {
      const entries = readdirSync(sp, { withFileTypes: true })
      skillCount += entries.filter(e => e.name.endsWith('.md') || e.isDirectory()).length
    } catch {}
  }
  printCheck({ status: skillCount > 0 ? 'pass' : 'warn', label: `${skillCount} skills discovered` })

  // ────── Summary ──────
  console.log()
  if (issues.length === 0) {
    console.log(`${GREEN}${BOLD}All checks passed${RESET}`)
  } else {
    console.log(`${RED}${BOLD}${issues.length} issue${issues.length !== 1 ? 's' : ''} found${RESET}`)
    for (const issue of issues) {
      const sym = issue.status === 'warn' ? SYM.warn : SYM.fail
      const detail = issue.detail ? ` ${DIM}(${issue.detail})${RESET}` : ''
      console.log(`  ${sym} ${issue.label}${detail}`)
    }
  }
  console.log()

  process.exit(issues.some(i => i.status === 'fail') ? 1 : 0)
}

// ── Tauri build-dependency check ──
//
// Developers building Tinstar from source need platform-specific `-dev`
// libraries that cargo links against at build time. End users running a
// shipped .dmg/.msi/.deb/.AppImage do NOT need these — the OS or the package
// manager covers their runtime needs. This `--tauri-dev` mode is the gate
// that tells a developer whether their box can build the Tauri shell.

function checkTauriDev() {
  const platform = process.platform
  console.log(`\n${BOLD}Tinstar Doctor — Tauri build dependencies${RESET} ${DIM}(developers only)${RESET}`)

  if (platform === 'darwin') {
    try {
      const path = execSync('xcode-select -p', { encoding: 'utf-8', stdio: 'pipe' }).trim()
      if (!path) throw new Error('empty path')
      printCheck({ status: 'pass', label: 'Xcode Command Line Tools', detail: path })
      console.log()
      return true
    } catch {
      printCheck({ status: 'fail', label: 'Xcode Command Line Tools — not found', detail: 'run: xcode-select --install' })
      console.log()
      return false
    }
  }

  if (platform === 'linux') {
    const debDeps = [
      ['webkit2gtk-4.1', 'libwebkit2gtk-4.1-dev'],
      ['gtk+-3.0', 'libgtk-3-dev'],
      ['ayatana-appindicator3-0.1', 'libayatana-appindicator3-dev'],
      ['librsvg-2.0', 'librsvg2-dev'],
    ]
    let allOk = true
    for (const [pkg, deb] of debDeps) {
      try {
        execSync(`pkg-config --exists ${pkg}`, { stdio: 'pipe' })
        printCheck({ status: 'pass', label: `${pkg}`, detail: deb })
      } catch {
        printCheck({ status: 'fail', label: `${pkg} — missing`, detail: `apt package: ${deb}` })
        allOk = false
      }
    }
    if (!allOk) {
      const missing = debDeps.map(([, d]) => d).join(' ')
      console.log(`\n${DIM}Install with:${RESET}`)
      console.log(`  sudo apt install -y ${missing} build-essential curl wget file libssl-dev`)
      console.log(`${DIM}(or your distro's equivalent for webkit2gtk-4.1, gtk+-3.0, ayatana-appindicator3, librsvg2)${RESET}`)
    }
    console.log()
    return allOk
  }

  if (platform === 'win32') {
    try {
      execSync('where cl.exe', { stdio: 'pipe' })
      printCheck({ status: 'pass', label: 'Visual Studio Build Tools (cl.exe)' })
      console.log()
      return true
    } catch {
      printCheck({ status: 'fail', label: 'Visual Studio Build Tools — cl.exe not found', detail: 'install: https://visualstudio.microsoft.com/visual-cpp-build-tools/' })
      console.log()
      return false
    }
  }

  console.log(`${DIM}Unknown platform ${platform} — no Tauri build-deps check.${RESET}\n`)
  return true
}

export { doctor, checkTauriDev }

// Auto-run when invoked directly
const isDirectRun = process.argv[1]?.endsWith('doctor.js')
if (isDirectRun) {
  if (process.argv.includes('--tauri-dev')) {
    const ok = checkTauriDev()
    process.exit(ok ? 0 : 1)
  }
  doctor().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
