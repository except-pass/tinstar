import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const NATS_MCP_OWNER_PROTOCOL_VERSION = 1

export function ownerFile(path) {
  return join(path, 'owner.json')
}

export function childFile(path, markerId) {
  return join(path, `.child-${markerId}.json`)
}

export function transitionPath(path) {
  return `${path}.transition`
}

function transitionFile(path) {
  return join(transitionPath(path), 'lease.json')
}

export function processIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const startTicks = fields[19]
      return bootId && startTicks ? `linux:${bootId}:${startTicks}` : undefined
    } catch {
      return undefined
    }
  }
  if (process.platform === 'darwin') {
    try {
      const started = execFileSync(
        'ps',
        ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8' },
      ).trim()
      return started ? `darwin:${started}` : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export function requiredProcessRecord(pid, label) {
  const identity = processIdentity(pid)
  if (!identity) throw new Error(`could not determine ${label} process identity for pid ${pid}`)
  return {
    version: NATS_MCP_OWNER_PROTOCOL_VERSION,
    pid,
    processIdentity: identity,
  }
}

function isProcessRecord(record) {
  return record?.version === NATS_MCP_OWNER_PROTOCOL_VERSION
    && Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid <= 0x7fff_ffff
    && typeof record.processIdentity === 'string' && record.processIdentity.length > 0
}

export function sameProcessRecord(left, right) {
  return isProcessRecord(left) && isProcessRecord(right)
    && left.pid === right.pid && left.processIdentity === right.processIdentity
}

export function processRecordState(record) {
  if (!isProcessRecord(record)) return 'gone'
  const pid = record.pid
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error?.code === 'ESRCH') return 'gone'
    return 'unknown'
  }
  const currentIdentity = processIdentity(pid)
  if (!currentIdentity) return 'unknown'
  return record.processIdentity === currentIdentity ? 'alive' : 'gone'
}

export function requiredProcessGroupRecord(pgid, label) {
  const leader = requiredProcessRecord(pgid, `${label} leader`)
  return { version: NATS_MCP_OWNER_PROTOCOL_VERSION, pgid, leaderProcessIdentity: leader.processIdentity }
}

function isProcessGroupRecord(record) {
  return record?.version === NATS_MCP_OWNER_PROTOCOL_VERSION
    && Number.isSafeInteger(record.pgid) && record.pgid > 0 && record.pgid <= 0x7fff_ffff
    && typeof record.leaderProcessIdentity === 'string' && record.leaderProcessIdentity.length > 0
}

export function processGroupRecordState(record) {
  if (!isProcessGroupRecord(record)) return 'gone'
  try { process.kill(-record.pgid, 0) } catch (error) {
    if (error?.code === 'ESRCH') return 'gone'
    return 'unknown'
  }
  const currentLeaderIdentity = processIdentity(record.pgid)
  return currentLeaderIdentity && currentLeaderIdentity !== record.leaderProcessIdentity
    ? 'gone'
    : 'alive'
}

export function processGroupRecordMayBeAlive(record) {
  return processGroupRecordState(record) !== 'gone'
}

export function recordedProcessGroupTargetIfMayBeAlive(record) {
  return processGroupRecordState(record) !== 'gone' && isProcessGroupRecord(record)
    ? -record.pgid : undefined
}

export function processRecordMayBeAlive(record) {
  return processRecordState(record) !== 'gone'
}

export function liveRecordedPid(record) {
  return processRecordState(record) === 'alive' ? record.pid : undefined
}

export function recordedPidIfMayBeAlive(record) {
  return processRecordState(record) !== 'gone' && isProcessRecord(record) ? record.pid : undefined
}

function incompatibleState(label, path, cause) {
  return new Error(`incompatible or malformed ${label} at ${path}`, { cause })
}

function parseRecordFile(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw incompatibleState(label, path, error)
  }
}

export function readOwner(path) {
  const ownerPath = ownerFile(path)
  const parsed = parseRecordFile(ownerPath, 'NATS MCP owner record')
  if (!parsed) {
    if (existsSync(path)) throw incompatibleState('NATS MCP owner generation', path)
    return null
  }
  if (parsed.version !== NATS_MCP_OWNER_PROTOCOL_VERSION
    || typeof parsed.markerId !== 'string' || parsed.markerId.length === 0
    || !isProcessRecord(parsed.launcher) || !isProcessRecord(parsed.principal)) {
    throw incompatibleState('NATS MCP owner record', ownerPath)
  }
  const childPath = childFile(path, parsed.markerId)
  const child = parseRecordFile(childPath, 'NATS MCP owner child record')
  if (child && (child.version !== NATS_MCP_OWNER_PROTOCOL_VERSION
    || child.markerId !== parsed.markerId || !isProcessRecord(child)
    || (child.state !== 'starting' && child.state !== 'started')
    || (child.state === 'starting' && child.channelGroup !== undefined)
    || (child.state === 'started' && !isProcessGroupRecord(child.channelGroup)))) {
    throw incompatibleState('NATS MCP owner child record', childPath)
  }
  return { ...parsed, child: child ?? undefined }
}

export function readTransition(path) {
  const canonical = transitionPath(path)
  const recordPath = transitionFile(path)
  const record = parseRecordFile(recordPath, 'NATS MCP owner transition')
  if (!record) {
    if (existsSync(canonical)) throw incompatibleState('NATS MCP owner transition', canonical)
    return null
  }
  if (!isProcessRecord(record) || typeof record.token !== 'string' || record.token.length === 0) {
    throw incompatibleState('NATS MCP owner transition', recordPath)
  }
  return record
}

function publishTransition(path) {
  const canonical = transitionPath(path)
  const staging = mkdtempSync(`${canonical}.pending-`)
  let published = false
  try {
    const record = {
      token: randomUUID(),
      ...requiredProcessRecord(process.pid, 'transition holder'),
    }
    writeFileSync(join(staging, 'lease.json'), JSON.stringify(record), { mode: 0o600 })
    renameSync(staging, canonical)
    published = true
    return record
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return null
    throw error
  } finally {
    if (!published) rmSync(staging, { recursive: true, force: true })
  }
}

export async function acquireTransition(
  path,
  { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  const canonical = transitionPath(path)
  while (true) {
    const record = publishTransition(path)
    if (record) return record

    const incumbent = readTransition(path)
    if (processRecordMayBeAlive(incumbent)) {
      if (Date.now() >= deadline) break
      await wait(25)
      continue
    }

    const abandoned = `${canonical}.abandoned-${randomUUID()}`
    try {
      renameSync(canonical, abandoned)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') continue
      throw error
    }
    rmSync(abandoned, { recursive: true, force: true })
  }
  throw new Error(`could not acquire owner transition ${canonical}`)
}

export function releaseTransition(path, record) {
  if (readTransition(path)?.token !== record?.token) return
  const canonical = transitionPath(path)
  const released = `${canonical}.release-${randomUUID()}`
  try {
    renameSync(canonical, released)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  rmSync(released, { recursive: true, force: true })
}

export function publishOwner(path, principal) {
  if (!isProcessRecord(principal)) throw new Error('owner principal process record is invalid')
  const staging = mkdtempSync(`${path}.pending-`)
  let published = false
  try {
    const record = {
      version: NATS_MCP_OWNER_PROTOCOL_VERSION,
      markerId: randomUUID(),
      launcher: requiredProcessRecord(process.pid, 'owner launcher'),
      principal,
    }
    writeFileSync(ownerFile(staging), JSON.stringify(record), { mode: 0o600 })
    renameSync(staging, path)
    published = true
    return record
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return null
    throw error
  } finally {
    if (!published) rmSync(staging, { recursive: true, force: true })
  }
}

function replaceOwnerChild(path, markerId, record) {
  const target = childFile(path, markerId)
  const staging = `${target}.pending-${randomUUID()}`
  try {
    writeFileSync(staging, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    renameSync(staging, target)
  } finally { rmSync(staging, { force: true }) }
}

export function registerOwnerChild(path, markerId, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (readOwner(path)?.markerId !== markerId) return null
  const record = {
    markerId,
    ...requiredProcessRecord(pid, 'owner supervisor'),
    state: 'starting',
  }
  replaceOwnerChild(path, markerId, record)
  const confirmed = readOwner(path)
  if (
    confirmed?.markerId === markerId
    && confirmed.child?.pid === pid
    && confirmed.child?.processIdentity === record.processIdentity
  ) return record

  rmSync(childFile(path, markerId), { force: true })
  return null
}

export function markOwnerChildStarted(path, record, channelPid) {
  const current = readOwner(path)
  if (
    current?.markerId !== record?.markerId
    || current.child?.pid !== record.pid
    || current.child?.processIdentity !== record.processIdentity
  ) return null
  const started = {
    ...record,
    state: 'started',
    channelGroup: requiredProcessGroupRecord(channelPid, 'channel server process group'),
  }
  replaceOwnerChild(path, record.markerId, started)
  return started
}

export function removeOwnerGeneration(path, markerId, suffix = 'retired') {
  if (readOwner(path)?.markerId !== markerId) return
  const retired = `${path}.${suffix}-${randomUUID()}`
  try {
    renameSync(path, retired)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const movedMarker = readOwner(retired)?.markerId
  if (movedMarker !== markerId) {
    try { renameSync(retired, path) } catch { /* preserve the current generation */ }
    return
  }
  rmSync(retired, { recursive: true, force: true })
}
