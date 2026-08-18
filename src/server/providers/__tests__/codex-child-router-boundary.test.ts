// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { codexMcpLaunchFlags } from '../codex-mcp'
import { reconnectSessionNats } from '../../sessions/natsReconnect'
import {
  generateNatsMcpConfig,
  natsControlSocketPath,
  natsOwnerLockPath,
} from '../../sessions/backends/tmux'

interface ChannelLaunch {
  args: string[]
  pid: number
  routerAuth?: string
}

interface OwnerChildRecord {
  pid: number
  channelGroup?: { pgid: number }
}

async function waitForLaunches(path: string, count: number): Promise<ChannelLaunch[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const launches = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as ChannelLaunch)
      if (launches.length >= count) return launches
    } catch {
      // The fake channel runtime has not written its first launch yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${count} channel-server launches`)
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`)
}

async function stop(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolve => process.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  ])
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (pidIsAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (pidIsAlive(pid)) throw new Error(`process ${pid} did not exit`)
}
async function waitForProcessExit(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  await new Promise<void>(resolve => process.once('exit', () => resolve()))
}

describe('Codex inherited managed-router boundary', () => {
  const roots: string[] = []
  const processes: ChildProcessWithoutNullStreams[] = []
  const channelPids: number[] = []

  afterEach(async () => {
    await Promise.all(processes.splice(0).map(stop))
    for (const pid of channelPids.splice(0)) {
      try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('keeps one inbound owner when a child launches the inherited required MCP descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-codex-child-router-'))
    roots.push(root)
    const sessionName = `child-boundary-${process.pid}-${Date.now()}`
    const launchesPath = join(root, 'channel-launches.jsonl')
    const fakeBunPath = join(root, 'fake-bun.mjs')
    writeFileSync(fakeBunPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.argv[3], JSON.stringify({
  args: process.argv.slice(2),
  pid: process.pid,
  routerAuth: process.env.TINSTAR_MESSAGE_ROUTER_AUTH,
}) + '\\n')
setInterval(() => {}, 1_000)
process.on('SIGTERM', () => process.exit(0))
`)
    chmodSync(fakeBunPath, 0o700)
    const distinctHostPath = join(root, 'distinct-mcp-host.mjs')
    writeFileSync(distinctHostPath, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
const child = spawn(process.argv[2], process.argv.slice(3), { env: process.env, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal))
child.once('error', error => { throw error })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
`)
    chmodSync(distinctHostPath, 0o700)

    const sessionsDir = join(root, 'sessions')
    const configPath = generateNatsMcpConfig({
      sessionsDir,
      sessionName,
      agentIncarnation: 'parent-v1',
      nats: { enabled: true, subscriptions: ['tinstar.space.parent'] },
      channelServerPackage: launchesPath,
      bunPath: fakeBunPath,
      jetstream: true,
      natsUrl: 'nats://127.0.0.1:4222',
      routerSubject: '_TINSTAR.delivery.route.v1.test',
      routerAuth: 'a'.repeat(64),
    })
    const descriptor = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: { nats: { command: string; args: string[]; env: Record<string, string> } }
    }
    const server = descriptor.mcpServers.nats
    const codexFlags = codexMcpLaunchFlags(configPath).join(' ')
    expect(codexFlags).toContain('required=true')

    // Codex 0.147 clones this exact effective server config into the child.
    // Launching the descriptor twice models that parent/child boundary rather
    // than nats-channel-mcp's narrower direct socket-collision test.
    const pauseEnv = 'TINSTAR_NATS_MCP_TEST_PAUSE_BEFORE_OWNER_REGISTRATION'
    const publicationPauseEnv = 'TINSTAR_NATS_MCP_TEST_PAUSE_BEFORE_OWNER_PUBLICATION'
    const launch = (extraEnv: Record<string, string> = {}, distinctHost = false) => {
      const env = { ...process.env, ...server.env, ...extraEnv }
      if (!(pauseEnv in extraEnv)) delete env[pauseEnv]
      if (!(publicationPauseEnv in extraEnv)) delete env[publicationPauseEnv]
      const command = distinctHost ? process.execPath : server.command
      const args = distinctHost ? [distinctHostPath, server.command, ...server.args] : server.args
      return spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    }
    const parent = launch()
    processes.push(parent)
    await waitForLaunches(launchesPath, 1)
    const child = launch({}, true)
    processes.push(child)
    const launches = await waitForLaunches(launchesPath, 2)
    const parentLaunch = launches[0]!
    const childLaunch = launches[1]!
    channelPids.push(parentLaunch.pid, childLaunch.pid)
    const parentArgs = parentLaunch.args
    const childArgs = childLaunch.args

    expect(parent.exitCode).toBeNull()
    expect(child.exitCode).toBeNull()
    expect(parentArgs).toContain('--topics-file')
    expect(parentArgs).toContain('--jetstream')
    expect(parentArgs).toContain('--control-socket')
    expect(parentArgs).toContain(natsControlSocketPath(sessionName))

    expect(childArgs).not.toContain('--topics-file')
    expect(childArgs).not.toContain('--jetstream')
    expect(childArgs).not.toContain('--control-socket')
    const subscribeIndex = childArgs.indexOf('--subscribe')
    expect(subscribeIndex).toBeGreaterThanOrEqual(0)
    expect(childArgs[subscribeIndex + 1]).toMatch(/^_TINSTAR\.reply-only\./)
    expect(parentLaunch.routerAuth).toBe('a'.repeat(64))
    expect(childLaunch.routerAuth).toBe(parentLaunch.routerAuth)

    await stop(child)
    const parentExit = new Promise<void>(resolve => parent.once('exit', () => resolve()))
    parent.kill('SIGKILL')
    await parentExit
    expect(pidIsAlive(parentLaunch.pid)).toBe(true)

    // The owner wrapper is gone, but its resource-owning child is still live.
    // A new inherited launch must remain reply-only instead of reclaiming the
    // stale launcher PID and duplicating the real subscriptions.
    const contender = launch()
    processes.push(contender)
    const contenderLaunch = (await waitForLaunches(launchesPath, 3))[2]!
    channelPids.push(contenderLaunch.pid)
    expect(contenderLaunch.args).not.toContain('--topics-file')
    expect(contenderLaunch.args).not.toContain('--control-socket')
    await stop(contender)

    const ownerLock = natsOwnerLockPath(sessionsDir, sessionName)
    const owner = JSON.parse(readFileSync(join(ownerLock, 'owner.json'), 'utf8')) as { markerId: string }
    const ownerChild = JSON.parse(
      readFileSync(join(ownerLock, `.child-${owner.markerId}.json`), 'utf8'),
    ) as OwnerChildRecord
    expect(ownerChild.channelGroup?.pgid).toBe(parentLaunch.pid)

    // The supervisor is bookkeeping, not the resource owner. Killing only it
    // must leave the exec'd channel authoritative and keep later inherited
    // launches reply-only.
    channelPids.push(ownerChild.pid)
    process.kill(ownerChild.pid, 'SIGKILL')
    await waitForPidExit(ownerChild.pid)
    expect(pidIsAlive(parentLaunch.pid)).toBe(true)
    const supervisorCrashContender = launch()
    processes.push(supervisorCrashContender)
    const supervisorCrashLaunch = (await waitForLaunches(launchesPath, 4))[3]!
    channelPids.push(supervisorCrashLaunch.pid)
    expect(supervisorCrashLaunch.args).not.toContain('--topics-file')
    expect(supervisorCrashLaunch.args).not.toContain('--control-socket')
    await stop(supervisorCrashContender)

    process.kill(parentLaunch.pid, 'SIGTERM')
    await waitForPidExit(parentLaunch.pid)
    const gapChild = launch({}, true)
    processes.push(gapChild)
    const gapChildLaunch = (await waitForLaunches(launchesPath, 5))[4]!
    channelPids.push(gapChildLaunch.pid)
    expect(gapChildLaunch.args).not.toContain('--topics-file')
    expect(gapChildLaunch.args).not.toContain('--control-socket')
    const replacement = launch()
    processes.push(replacement)
    const replacementLaunch = (await waitForLaunches(launchesPath, 6))[5]!
    channelPids.push(replacementLaunch.pid)
    expect(replacementLaunch.args).toContain('--topics-file')
    expect(replacementLaunch.args).toContain('--control-socket')
    await stop(gapChild)
    await stop(replacement)

    await reconnectSessionNats(sessionName, { socketPath: natsControlSocketPath(sessionName), ownerLockPath: ownerLock, findPids: async () => [] })
    expect(existsSync(ownerLock)).toBe(false)

    // Mixed-version state fails closed rather than being reclaimed.
    mkdirSync(ownerLock, { mode: 0o700 })
    writeFileSync(join(ownerLock, 'owner.json'), JSON.stringify({
      version: 2,
      markerId: 'future',
      launcher: { version: 2, pid: process.pid, processIdentity: 'future' },
      principal: { version: 2, pid: process.pid, processIdentity: 'future' },
    }))
    const incompatible = launch()
    processes.push(incompatible)
    await waitForProcessExit(incompatible)
    expect(incompatible.exitCode).not.toBe(0)
    expect(readFileSync(join(ownerLock, 'owner.json'), 'utf8')).toContain('"version":2')
    expect(readFileSync(launchesPath, 'utf8').trim().split('\n')).toHaveLength(6)
    rmSync(ownerLock, { recursive: true })
    const recovered = launch()
    processes.push(recovered)
    const recoveredLaunch = (await waitForLaunches(launchesPath, 7))[6]!
    channelPids.push(recoveredLaunch.pid)
    expect(recoveredLaunch.args).toContain('--topics-file')
    await stop(recovered)
    await reconnectSessionNats(sessionName, { socketPath: natsControlSocketPath(sessionName), ownerLockPath: ownerLock, findPids: async () => [] })
    expect(existsSync(ownerLock)).toBe(false)

    // Fault-inject the exact interval from the native review: the owner has
    // spawned its supervisor, but that supervisor has not registered itself or
    // started the real channel server. If the launcher is SIGKILLed here, a
    // concurrent contenders may race to take ownership; the serialized
    // transition must invalidate the stale supervisor and publish one winner.
    const pauseFile = join(root, 'owner-child-paused')
    const pausedOwner = launch({ [pauseEnv]: pauseFile })
    processes.push(pausedOwner)
    await waitForFile(pauseFile)
    const pausedSupervisorPid = Number(readFileSync(pauseFile, 'utf8'))
    channelPids.push(pausedSupervisorPid)
    const pausedOwnerExit = new Promise<void>(resolve => pausedOwner.once('exit', () => resolve()))
    pausedOwner.kill('SIGKILL')
    await pausedOwnerExit

    const takeoverA = launch()
    processes.push(takeoverA)
    const takeoverB = launch()
    processes.push(takeoverB)
    await waitForLaunches(launchesPath, 8)
    writeFileSync(`${pauseFile}.release`, 'release')
    await waitForPidExit(pausedSupervisorPid)

    const takeoverLaunches = (await waitForLaunches(launchesPath, 9)).slice(7, 9)
    channelPids.push(...takeoverLaunches.map(item => item.pid))
    const inboundTakeovers = takeoverLaunches.filter(item => item.args.includes('--topics-file'))
    const followerTakeovers = takeoverLaunches.filter(item => !item.args.includes('--topics-file'))
    expect(inboundTakeovers).toHaveLength(1)
    expect(inboundTakeovers[0]!.args).toContain('--control-socket')
    expect(followerTakeovers).toHaveLength(1)
    expect(followerTakeovers[0]!.args).not.toContain('--control-socket')
    await stop(takeoverA)
    await stop(takeoverB)
    await reconnectSessionNats(sessionName, { socketPath: natsControlSocketPath(sessionName), ownerLockPath: ownerLock, findPids: async () => [] })
    expect(existsSync(ownerLock)).toBe(false)

    // Lifecycle retirement owns the same transition used by supervisor
    // registration. A supervisor that has not registered yet is therefore
    // invalidated even when no channel process exists to signal.
    const latePauseFile = join(root, 'late-owner-child-paused')
    const lateOwner = launch({ [pauseEnv]: latePauseFile })
    processes.push(lateOwner)
    await waitForFile(latePauseFile)
    const lateSupervisorPid = Number(readFileSync(latePauseFile, 'utf8'))
    channelPids.push(lateSupervisorPid)
    const lateOwnerExit = new Promise<void>(resolve => lateOwner.once('exit', () => resolve()))
    lateOwner.kill('SIGKILL')
    await lateOwnerExit

    const retired = await reconnectSessionNats(sessionName, {
      socketPath: natsControlSocketPath(sessionName),
      ownerLockPath: ownerLock,
      findPids: async () => [],
    })
    expect(retired.killed).toEqual([])
    writeFileSync(`${latePauseFile}.release`, 'release')
    await waitForPidExit(lateSupervisorPid)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(readFileSync(launchesPath, 'utf8').trim().split('\n')).toHaveLength(9)

    const postRetirement = launch()
    processes.push(postRetirement)
    const postRetirementLaunch = (await waitForLaunches(launchesPath, 10))[9]!
    channelPids.push(postRetirementLaunch.pid)
    expect(postRetirementLaunch.args).toContain('--topics-file')
    expect(postRetirementLaunch.args).toContain('--control-socket')
    await stop(postRetirement)
    await reconnectSessionNats(sessionName, { socketPath: natsControlSocketPath(sessionName), ownerLockPath: ownerLock, findPids: async () => [] })
    expect(existsSync(ownerLock)).toBe(false)

    // A launcher that has begun claiming ownership must be visible to a
    // lifecycle reap even before owner.json is published. The transition lease
    // makes reap wait, then orders publication before retirement can finish.
    const launchesBeforePublicationRace = readFileSync(launchesPath, 'utf8').trim().split('\n').length
    const publicationPauseFile = join(root, 'owner-publication-paused')
    const prePublicationOwner = launch({ [publicationPauseEnv]: publicationPauseFile })
    processes.push(prePublicationOwner)
    await waitForFile(publicationPauseFile)

    let reapSettled = false
    const publicationReap = reconnectSessionNats(sessionName, {
      socketPath: natsControlSocketPath(sessionName),
      ownerLockPath: ownerLock,
      findPids: async () => {
        try {
          return readFileSync(launchesPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => (JSON.parse(line) as ChannelLaunch).pid)
            .filter(pidIsAlive)
        } catch {
          return []
        }
      },
    }).finally(() => { reapSettled = true })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(reapSettled).toBe(false)
    writeFileSync(`${publicationPauseFile}.release`, 'release')
    await publicationReap
    await stop(prePublicationOwner)

    const publicationRaceLaunches = readFileSync(launchesPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(launchesBeforePublicationRace)
      .map(line => JSON.parse(line) as ChannelLaunch)
    expect(publicationRaceLaunches.every(item => !pidIsAlive(item.pid))).toBe(true)
    expect(existsSync(ownerLock)).toBe(false)
  }, 20_000)
})
