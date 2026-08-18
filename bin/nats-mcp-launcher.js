#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireTransition,
  markOwnerChildStarted,
  processGroupRecordMayBeAlive,
  processRecordMayBeAlive,
  publishOwner,
  readOwner,
  registerOwnerChild,
  requiredProcessRecord,
  releaseTransition,
  removeOwnerGeneration,
  sameProcessRecord,
} from './nats-mcp-owner-state.js'
import { buildReplyOnlySubject } from './nats-subjects.js'

function ownerIsAlive(owner) {
  if (!owner) return false
  // Once startup commits, the gated shell has exec'd the channel server without
  // changing PID or process birth identity. It remains authoritative even if
  // either JavaScript supervisor is hard-killed.
  if (owner.child?.channelGroup) return processGroupRecordMayBeAlive(owner.child.channelGroup)
  if (owner.child) return processRecordMayBeAlive(owner.child)
  return processRecordMayBeAlive(owner.launcher)
}

async function pauseBeforeOwnerPublicationForTest() {
  const readyFile = process.env.TINSTAR_NATS_MCP_TEST_PAUSE_BEFORE_OWNER_PUBLICATION
  if (!readyFile) return
  writeFileSync(readyFile, String(process.pid), { mode: 0o600 })
  while (!existsSync(`${readyFile}.release`)) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
}

async function claimOwner(path) {
  const principal = requiredProcessRecord(process.ppid, 'MCP host')
  const transition = await acquireTransition(path)
  try {
    const current = readOwner(path)
    if (ownerIsAlive(current)) {
      releaseTransition(path, transition)
      return { owner: false, record: null, transition: null }
    }

    if (current) {
      if (!sameProcessRecord(current.principal, principal)) {
        releaseTransition(path, transition)
        return { owner: false, record: null, transition: null }
      }
      removeOwnerGeneration(path, current.markerId, 'abandoned')
    }

    await pauseBeforeOwnerPublicationForTest()
    const record = publishOwner(path, principal)
    if (!record) throw new Error(`could not publish owner generation ${path}`)
    return { owner: true, record, transition }
  } catch (error) {
    releaseTransition(path, transition)
    throw error
  }
}

function replyOnlyArgs(args) {
  const result = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--topics-file' || arg === '--control-socket' || arg === '--subscribe') {
      index++
      continue
    }
    if (arg === '--jetstream') continue
    result.push(arg)
  }
  const nonce = `${process.pid}.${randomBytes(16).toString('hex')}`
  result.push('--subscribe', buildReplyOnlySubject(nonce))
  return result
}

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const ownerLockIndex = argv.indexOf('--owner-lock')
  const ownerLock = ownerLockIndex >= 0 ? argv[ownerLockIndex + 1] : undefined
  const command = separator >= 0 ? argv[separator + 1] : undefined
  if (!ownerLock || separator < 0 || !command) {
    throw new Error('usage: nats-mcp-launcher --owner-lock <path> -- <command> [args...]')
  }
  return { ownerLock, command, args: argv.slice(separator + 2) }
}

function parseOwnerChildArgs(argv) {
  const separator = argv.indexOf('--')
  const ownerLock = argv[1]
  const markerId = argv[2]
  const command = separator >= 0 ? argv[separator + 1] : undefined
  if (argv[0] !== '--owner-child' || !ownerLock || !markerId || separator < 0 || !command) {
    throw new Error('invalid internal owner-child invocation')
  }
  return { ownerLock, markerId, command, args: argv.slice(separator + 2) }
}

function releaseOwnerUnlocked(path, record) {
  if (!record) return
  removeOwnerGeneration(path, record.markerId, 'release')
}

async function releaseOwner(path, record) {
  if (!record) return
  const transition = await acquireTransition(path)
  try {
    releaseOwnerUnlocked(path, record)
  } finally {
    releaseTransition(path, transition)
  }
}

function supervise(command, args) {
  const child = spawn(command, args, {
    env: process.env,
    stdio: 'inherit',
  })
  const forward = signal => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  process.once('SIGTERM', () => forward('SIGTERM'))
  process.once('SIGINT', () => forward('SIGINT'))
  const spawned = new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn)
    child.once('error', reject)
  })
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  return { exit, forward, spawned, pid: child.pid }
}

function superviseGated(command, args) {
  // fd 3 is a private startup gate. The shell cannot exec the real channel
  // server until its durable PID/identity record is committed. If this
  // supervisor is SIGKILLed first, EOF makes the shell exit, so an unrecorded
  // subscriber can never escape the transition lease.
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'IFS= read -r ready <&3 || exit 1; exec 3<&-; exec "$@"',
      'tinstar-channel',
      command,
      ...args,
    ],
    {
      detached: true,
      env: process.env,
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    },
  )
  const forward = signal => {
    try { process.kill(-child.pid, signal) } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  process.once('SIGTERM', () => forward('SIGTERM'))
  process.once('SIGINT', () => forward('SIGINT'))
  const spawned = new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn)
    child.once('error', reject)
  })
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  return {
    exit,
    forward,
    spawned,
    pid: child.pid,
    releaseGate: () => child.stdio[3]?.end('ready\n'),
  }
}

async function pauseBeforeOwnerRegistrationForTest() {
  const readyFile = process.env.TINSTAR_NATS_MCP_TEST_PAUSE_BEFORE_OWNER_REGISTRATION
  if (!readyFile) return
  writeFileSync(readyFile, String(process.pid), { mode: 0o600 })
  while (true) {
    try {
      readFileSync(`${readyFile}.release`)
      return
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 10))
    }
  }
}

async function runOwnerChild(argv) {
  const parsed = parseOwnerChildArgs(argv)
  await pauseBeforeOwnerRegistrationForTest()

  // Registration and process creation are one serialized transition. A
  // lifecycle reaper either runs before this block and removes the generation,
  // or runs after the real channel process exists and can target it.
  const transition = await acquireTransition(parsed.ownerLock)
  let ownerRecord
  let supervised
  try {
    ownerRecord = registerOwnerChild(parsed.ownerLock, parsed.markerId, process.pid)
    if (!ownerRecord) {
      throw new Error(`lost owner generation before channel-server startup at ${parsed.ownerLock}`)
    }
    supervised = superviseGated(parsed.command, parsed.args)
    await supervised.spawned
    ownerRecord = markOwnerChildStarted(parsed.ownerLock, ownerRecord, supervised.pid)
    if (!ownerRecord) {
      throw new Error(`lost owner generation during channel-server startup at ${parsed.ownerLock}`)
    }
    supervised.releaseGate()
  } catch (error) {
    if (supervised) {
      supervised.forward('SIGTERM')
      await supervised.exit.catch(() => undefined)
    }
    releaseOwnerUnlocked(parsed.ownerLock, ownerRecord)
    throw error
  } finally {
    releaseTransition(parsed.ownerLock, transition)
  }

  let result
  try {
    result = await supervised.exit
    while (processGroupRecordMayBeAlive(ownerRecord.channelGroup)) {
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
  } catch (error) {
    supervised.forward('SIGTERM')
    await supervised.exit.catch(() => undefined)
    throw error
  }
  process.exitCode = result.code ?? (result.signal ? 1 : 0)
}

export async function run(argv = process.argv.slice(2)) {
  process.umask(0o077)
  const parsed = parseArgs(argv)
  const claim = await claimOwner(parsed.ownerLock)
  console.error(`[tinstar-nats-mcp] ${claim.owner ? 'inbound owner' : 'reply-only follower'}`)

  const scriptPath = fileURLToPath(import.meta.url)
  const command = claim.owner ? process.execPath : parsed.command
  const childArgs = claim.owner
    ? [
        scriptPath,
        '--owner-child',
        parsed.ownerLock,
        claim.record.markerId,
        '--',
        parsed.command,
        ...parsed.args,
      ]
    : replyOnlyArgs(parsed.args)
  let supervised
  let result
  try {
    supervised = supervise(command, childArgs)
    await supervised.spawned
    if (claim.transition) {
      releaseTransition(parsed.ownerLock, claim.transition)
      claim.transition = null
    }
    result = await supervised.exit
  } catch (error) {
    if (supervised) {
      supervised.forward('SIGTERM')
      await supervised.exit.catch(() => undefined)
    }
    if (claim.transition) {
      releaseOwnerUnlocked(parsed.ownerLock, claim.record)
      releaseTransition(parsed.ownerLock, claim.transition)
    } else {
      await releaseOwner(parsed.ownerLock, claim.record)
    }
    throw error
  }
  // Keep the generation as root-host eligibility until lifecycle reaping.
  process.exitCode = result.code ?? (result.signal ? 1 : 0)
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  const invocation = process.argv.slice(2)
  const task = invocation[0] === '--owner-child'
    ? runOwnerChild(invocation)
    : run(invocation)
  task.catch(error => {
    console.error(`[tinstar-nats-mcp] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
