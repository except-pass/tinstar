// Small executable helpers for the guarded deploy; credentials never leave memory.
import { appendFile, mkdtemp, readFile, rm, statfs } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { userInfo, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { http } from './post-deploy-smoke.mjs'

export async function runningSha(e = process.env) {
  try {
    const body = await (await http(`${e.TINSTAR_BRIDGE_URL ?? 'http://127.0.0.1:5281'}/api/deployment`)).json()
    return body.ok && /^[a-f0-9]{40}$/.test(body.data?.sha) ? body.data.sha : null
  } catch { return null }
}

export async function audit(action, gate, reason) {
  const e = process.env
  let head = 'unavailable'
  try { head = execFileSync('git', ['-C', e.TINSTAR_DEPLOY_SOURCE ?? '/home/farm/srv/tinstar-src', 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || head } catch { /* A broken checkout must still be recoverable. */ }
  const entry = { time: new Date().toISOString(), user: userInfo().username, action, gate, reason, head }
  const line = JSON.stringify(entry)
  try {
    await appendFile(`${e.TINSTAR_DEPLOY_BLOCK ?? join(e.TINSTAR_CONFIG_HOME, 'deploy.blocked')}.audit.jsonl`, line + '\n', { mode: 0o600 })
  } catch {
    console.error('Cannot append deploy audit log; repair marker directory permissions or disk space and retry')
    throw Error('Audit unavailable')
  }
  console.error(`Tin Star deploy audit: ${line}`)
}

export async function preflight() {
  const e = process.env, errors = []
  const check = async (label, fn) => { try { await fn() } catch { errors.push(label) } }
  await check('audit log unwritable; repair marker directory permissions or disk space', () =>
    appendFile(`${e.TINSTAR_DEPLOY_BLOCK ?? join(e.TINSTAR_CONFIG_HOME, 'deploy.blocked')}.audit.jsonl`, '', { mode: 0o600 }))
  await check('Ask config unreadable or missing owner/bridge credentials', async () => {
    const { ask } = JSON.parse(await readFile(join(e.TINSTAR_CONFIG_HOME, 'config.json'), 'utf8'))
    if (!ask?.ownerLogins?.length || typeof ask.bridgeToken !== 'string' || ask.bridgeToken.length < 32) throw Error()
  })
  await check('caller header unreadable or invalid', async () => {
    if (!/^Bearer [^\s]{32,}(?:\r?\n)?$/.test(await readFile(e.TINSTAR_CALLER_HEADER_FILE ?? '/home/farm/.config/tinstar-tunnel/facade-caller-header', 'utf8'))) throw Error()
  })
  await check('approved tools unreadable or invalid', async () => {
    const names = JSON.parse(await readFile(e.TINSTAR_APPROVED_TOOLS_FILE ?? fileURLToPath(new URL('./approved-tools.json', import.meta.url)), 'utf8'))
    if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string') || new Set(names).size !== names.length) throw Error()
  })
  if (!process.argv.includes('--check-only')) {
    for (const file of ['package.json', 'package-lock.json']) await check(`source ${file} unreadable`, () => readFile(join(e.TINSTAR_DEPLOY_SOURCE, file)))
  }
  // Avoid partial artifact/state writes when a filesystem is already nearly full.
  for (const path of [e.TINSTAR_CONFIG_HOME, ...(process.argv.includes('--check-only') ? [] : [e.TINSTAR_DEPLOY_SOURCE])]) {
    await check(`disk space unavailable or below 256 MiB: ${path}`, async () => {
      const disk = await statfs(path)
      if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw Error()
    })
  }
  // Probe configured listeners, never bind or disturb a service. A stopped service
  // can be deliberately repaired by deploying with an audited override.
  const endpoints = { owner: e.TINSTAR_OWNER_URL ?? 'https://hulk.taile890bc.ts.net:8450', bridge: e.TINSTAR_BRIDGE_URL ?? 'http://127.0.0.1:5281',
    facade: e.TINSTAR_FACADE_URL ?? 'http://127.0.0.1:5297/mcp', 'tunnel target': e.TINSTAR_TUNNEL_TARGET_URL ?? 'http://127.0.0.1:5297/mcp', 'tunnel health': e.TINSTAR_TUNNEL_HEALTH_URL ?? 'http://127.0.0.1:5298' }
  await Promise.all(Object.entries(endpoints).map(([name, endpoint]) => check(`${name}: invalid URL or unavailable port`, async () => {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) throw Error()
    await new Promise((done, reject) => {
      const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
      socket.setTimeout(2000)
      socket.once('connect', () => { socket.destroy(); done() })
      socket.once('timeout', () => { socket.destroy(); reject(Error()) })
      socket.once('error', reject)
    })
  })))
  for (const error of errors) console.error(`Preflight: ${error}`)
  return errors.length ? 1 : 0
}

export async function unitTests() {
  const temp = await mkdtemp(join(tmpdir(), 'tinstar-unit-gate-'))
  const report = join(temp, 'results.json')
  const run = args => spawnSync('npm', ['run', 'test:unit', '--', ...args], { stdio: 'inherit', env: { ...process.env, NODE_ENV: undefined } }).status ?? 1
  try {
    const code = run(['--reporter=default', '--reporter=json', `--outputFile=${report}`])
    if (code === 0) return 0
    let files
    try {
      const result = JSON.parse(await readFile(report, 'utf8'))
      files = [...new Set(result.testResults.filter(test => test.status === 'failed').map(test => test.name))]
      if (!files.length || files.some(file => typeof file !== 'string' || !file)) throw Error()
    } catch {
      console.error('Unit suite failed without usable failed-file results; cannot isolate a rerun')
      return code
    }
    console.error(`Rerunning failed test files once, isolated and serially:\n${files.join('\n')}`)
    // One fresh Vitest process per file also isolates module and worker state.
    let failed = false
    for (const file of files) if (run([file, '--no-file-parallelism', '--maxWorkers=1', '--minWorkers=1', '--isolate']) !== 0) failed = true
    if (failed) return code
    const reason = `Full suite failed; isolated serial rerun passed: ${files.join(', ')}`
    await audit('warning', 'unit-tests', reason)
    console.error(`WARNING Tin Star deploy: ${reason}`)
    return 0
  } finally { await rm(temp, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2)
  try {
    if (action === 'old-sha') console.log(await runningSha() ?? 'unknown')
    else if (action === 'audit') await audit(...args)
    else if (action === 'preflight') process.exitCode = await preflight()
    else if (action === 'unit-tests') process.exitCode = await unitTests()
    else throw Error('Unknown deploy helper command')
  } catch { console.error('Deploy helper failed (credentials withheld)'); process.exitCode = 1 }
}
