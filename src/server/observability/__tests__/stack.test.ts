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
