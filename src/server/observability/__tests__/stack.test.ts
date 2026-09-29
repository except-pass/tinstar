/**
 * Unit tests for ObservabilityStack lifecycle.
 *
 * Real-binary flows (install, probe, supervisor adoption) are covered by the
 * nightly integration job and are out of CI scope (spec line 222-223). These
 * tests cover the guard-rail paths that don't require real binaries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ObservabilityStack } from '../index'

let tmp: string

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('ObservabilityStack — TINSTAR_TELEMETRY=0 guard', () => {
  it('sets state to "disabled" without acquiring a lock or spawning anything', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    vi.stubEnv('TINSTAR_TELEMETRY', '0')

    const stack = new ObservabilityStack({ configRoot: tmp })
    expect(stack.state).toBe('idle')

    await stack.start()

    expect(stack.state).toBe('disabled')
    // No lock marker should have been created inside obsRoot
    const obsRoot = join(tmp, 'observability')
    // obsRoot itself should not have been created (mkdirSync is called after the guard)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(obsRoot, 'observability.lock.mark'))).toBe(false)
    // query stays null — nothing was downloaded
    expect(stack.query).toBeNull()
    // progress stays empty
    expect(stack.progress).toHaveLength(0)
  })

  it('restart() on a disabled stack stays disabled and does not throw', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    vi.stubEnv('TINSTAR_TELEMETRY', '0')

    const stack = new ObservabilityStack({ configRoot: tmp })
    await stack.start()
    expect(stack.state).toBe('disabled')

    // stop() on a disabled stack (no lock, no supervisors) should be a no-op
    await stack.stop()
    expect(stack.state).toBe('idle')

    // start again with env still set — should go back to disabled
    await stack.start()
    expect(stack.state).toBe('disabled')
  })

  it('progress is cleared between restarts', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    vi.stubEnv('TINSTAR_TELEMETRY', '0')

    const stack = new ObservabilityStack({ configRoot: tmp })
    // Manually inject a progress entry to simulate a partial download state
    // that would have been present before a restart
    ;(stack as unknown as { progress: unknown[] }).progress.push({ component: 'prometheus', bytesReceived: 100, bytesTotal: 1000 })
    expect(stack.progress).toHaveLength(1)

    // restart() calls stop() then clears progress, then start()
    await stack.restart()

    // After restart with telemetry disabled, progress must be cleared
    expect(stack.progress).toHaveLength(0)
    expect(stack.state).toBe('disabled')
  })
})

describe('ObservabilityStack shutdown ownership', () => {
  it('serializes a concurrent stop and restart without releasing the new lock', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    let releaseFirstStop!: () => void
    let firstStopEntered!: () => void
    const held = new Promise<void>(resolve => { releaseFirstStop = resolve })
    const entered = new Promise<void>(resolve => { firstStopEntered = resolve })
    let alloyStops = 0
    const alloy = {
      state: 'ready',
      stop: vi.fn(async () => {
        alloyStops++
        if (alloyStops === 1) {
          firstStopEntered()
          await held
        }
        alloy.state = 'idle'
      }),
    }
    const prom = {
      state: 'ready',
      stop: vi.fn(async () => { prom.state = 'idle' }),
    }
    const oldRelease = vi.fn(async () => {})
    const newRelease = vi.fn(async () => {})
    const fakeStart = vi.fn(async () => {
      internals.lockRelease = newRelease
      alloy.state = 'ready'
      prom.state = 'ready'
      stack.state = 'ready'
    })
    const internals = stack as unknown as {
      prom: typeof prom | null
      alloy: typeof alloy | null
      lockRelease: (() => Promise<void>) | null
      startUnlocked?: () => Promise<void>
    }
    internals.prom = prom
    internals.alloy = alloy
    internals.lockRelease = oldRelease
    internals.startUnlocked = fakeStart
    stack.start = fakeStart
    stack.state = 'ready'

    const stopping = stack.stop()
    await entered
    const restarting = stack.restart()
    await Promise.resolve()
    expect(alloy.stop).toHaveBeenCalledTimes(1)

    releaseFirstStop()
    await expect(Promise.all([stopping, restarting])).resolves.toBeDefined()

    expect(oldRelease).toHaveBeenCalledOnce()
    expect(newRelease).not.toHaveBeenCalled()
    expect(internals.lockRelease).toBe(newRelease)
    expect(stack.state).toBe('ready')
  })

  it('stays degraded and retries ownership release after a filesystem error', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    const releaseError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const release = vi.fn()
      .mockRejectedValueOnce(releaseError)
      .mockResolvedValueOnce(undefined)
    const internals = stack as unknown as {
      lockRelease: (() => Promise<void>) | null
    }
    internals.lockRelease = release
    stack.state = 'ready'

    await expect(stack.stop()).rejects.toBe(releaseError)

    expect(stack.state).toBe('degraded')
    expect(stack.lastError).toBe('permission denied')
    expect(internals.lockRelease).toBe(release)

    await expect(stack.stop()).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(2)
    expect(stack.state).toBe('idle')
    expect(stack.lastError).toBeNull()
    expect(internals.lockRelease).toBeNull()
  })

  it('retains its lock and reports degraded when a child stop is unconfirmed', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    const release = vi.fn(async () => {})
    const failedStop = new Error('alloy process 42 did not stop')
    const internals = stack as unknown as {
      prom: { stop: () => Promise<void> } | null
      alloy: { stop: () => Promise<void> } | null
      lockRelease: (() => Promise<void>) | null
    }
    internals.prom = { stop: vi.fn(async () => {}) }
    internals.alloy = { stop: vi.fn(async () => { throw failedStop }) }
    internals.lockRelease = release
    stack.state = 'ready'

    await expect(stack.stop()).rejects.toThrow('alloy process 42 did not stop')

    expect(stack.state).toBe('degraded')
    expect(stack.lastError).toContain('alloy process 42 did not stop')
    expect(release).not.toHaveBeenCalled()
    expect(internals.lockRelease).toBe(release)
  })

  it('releases its lock when a late child exit completes a failed stop', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    const release = vi.fn(async () => {})
    const failedStop = new Error('alloy process 42 did not stop')
    const prom = {
      state: 'ready',
      stop: vi.fn(async () => { prom.state = 'idle' }),
    }
    const alloy = {
      state: 'ready',
      stop: vi.fn(async () => { throw failedStop }),
    }
    const internals = stack as unknown as {
      prom: typeof prom | null
      alloy: typeof alloy | null
      lockRelease: (() => Promise<void>) | null
      onSupervisorStateChange: (name: string, state: 'idle') => void
    }
    internals.prom = prom
    internals.alloy = alloy
    internals.lockRelease = release
    stack.state = 'ready'

    await expect(stack.stop()).rejects.toThrow('alloy process 42 did not stop')

    alloy.state = 'idle'
    internals.onSupervisorStateChange('alloy', 'idle')

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(stack.state).toBe('idle')
    expect(stack.lastError).toBeNull()
    expect(internals.lockRelease).toBeNull()
  })

  it('retries a transient late lock-release failure with bounded backoff', async () => {
    vi.useFakeTimers()
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    const release = vi.fn()
      .mockRejectedValueOnce(new Error('transient release failure'))
      .mockResolvedValueOnce(undefined)
    const failedStop = new Error('alloy process 42 did not stop')
    const prom = {
      state: 'ready',
      stop: vi.fn(async () => { prom.state = 'idle' }),
    }
    const alloy = {
      state: 'ready',
      stop: vi.fn(async () => { throw failedStop }),
    }
    const internals = stack as unknown as {
      prom: typeof prom | null
      alloy: typeof alloy | null
      lockRelease: (() => Promise<void>) | null
      onSupervisorStateChange: (name: string, state: 'idle') => void
    }
    internals.prom = prom
    internals.alloy = alloy
    internals.lockRelease = release
    stack.state = 'ready'

    await expect(stack.stop()).rejects.toThrow('alloy process 42 did not stop')
    alloy.state = 'idle'
    internals.onSupervisorStateChange('alloy', 'idle')
    await Promise.resolve()
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(stack.state).toBe('degraded')

    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(2)
    expect(stack.state).toBe('idle')
    expect(stack.lastError).toBeNull()
    expect(internals.lockRelease).toBeNull()
  })

  it('bounds persistent late lock-release retries and remains visibly degraded', async () => {
    vi.useFakeTimers()
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    const release = vi.fn(async () => { throw new Error('persistent release failure') })
    const failedStop = new Error('alloy process 42 did not stop')
    const prom = {
      state: 'ready',
      stop: vi.fn(async () => { prom.state = 'idle' }),
    }
    const alloy = {
      state: 'ready',
      stop: vi.fn(async () => { throw failedStop }),
    }
    const internals = stack as unknown as {
      prom: typeof prom | null
      alloy: typeof alloy | null
      lockRelease: (() => Promise<void>) | null
      onSupervisorStateChange: (name: string, state: 'idle') => void
    }
    internals.prom = prom
    internals.alloy = alloy
    internals.lockRelease = release
    stack.state = 'ready'

    await expect(stack.stop()).rejects.toThrow('alloy process 42 did not stop')
    alloy.state = 'idle'
    internals.onSupervisorStateChange('alloy', 'idle')
    await Promise.resolve()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(250 + 500 + 1_000)
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(release).toHaveBeenCalledTimes(4)
    expect(stack.state).toBe('degraded')
    expect(stack.lastError).toBe('persistent release failure')
    expect(internals.lockRelease).toBe(release)
  })

  it('completes stop when all children become idle before recovery is armed', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tinstar-obs-test-'))
    const stack = new ObservabilityStack({ configRoot: tmp })
    const release = vi.fn(async () => {})
    const failedStop = new Error('alloy process 42 did not stop')
    const prom = {
      state: 'ready',
      stop: vi.fn(async () => { prom.state = 'idle' }),
    }
    const alloy = {
      state: 'ready',
      stop: vi.fn(async () => {
        alloy.state = 'idle'
        throw failedStop
      }),
    }
    const internals = stack as unknown as {
      prom: typeof prom | null
      alloy: typeof alloy | null
      lockRelease: (() => Promise<void>) | null
    }
    internals.prom = prom
    internals.alloy = alloy
    internals.lockRelease = release
    stack.state = 'ready'

    await expect(stack.stop()).resolves.toBeUndefined()

    expect(release).toHaveBeenCalledOnce()
    expect(stack.state).toBe('idle')
    expect(stack.lastError).toBeNull()
    expect(internals.lockRelease).toBeNull()
  })
})
