// Port safety after the refresh fleet was removed (plan U1, R12/R19).
//
// WHAT THESE NOW PROVE. There is exactly ONE port window — the interactive one —
// because refresh creates no managed session and therefore claims no port. So the
// scenarios are no longer "the refresh fleet cannot starve a user":
//
//   · the interactive window is the only window the shipped config declares;
//   · a retired `ports.refreshStart` / `refreshCount` in a user's config.json is
//     DROPPED at parse rather than carried into the frozen config;
//   · a retired `refresh.autonomousWorkers` / `maxConcurrentWorkers` is dropped too,
//     so no config value can name a worker path back into existence;
//   · `findPort`'s overlap refusal still guards the interactive window against any
//     future window that tried to reach into it.
//
// `findPort` binds a real loopback listener to test a port, so these tests use
// windows in the ephemeral-ish high range and release everything they claim.
import { describe, it, expect, afterEach } from 'vitest'
import {
  findPort, releasePort, setInteractivePortWindow, interactivePortWindow as registeredWindow,
} from '../backends/tmux'
import {
  portWindowsOverlap, interactivePortWindow, loadConfig,
  BASE_CONFIG, type PortWindow, type TinstarConfig,
} from '../config'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A window far from anything the dev machine is likely to be using. */
const INTERACTIVE: PortWindow = { label: 'interactive', start: 19_681, count: 10 }

const claimed: number[] = []

afterEach(() => {
  for (const p of claimed.splice(0)) releasePort(p)
  setInteractivePortWindow(null)
})

async function claim(window: PortWindow): Promise<number> {
  const port = await findPort(window)
  claimed.push(port)
  return port
}

describe('port windows', () => {
  it('overlap is symmetric and inclusive of the last port', () => {
    expect(portWindowsOverlap({ label: 'a', start: 100, count: 10 }, { label: 'b', start: 109, count: 1 })).toBe(true)
    expect(portWindowsOverlap({ label: 'b', start: 109, count: 1 }, { label: 'a', start: 100, count: 10 })).toBe(true)
    // Adjacent, not overlapping: 100-109 then 110-119.
    expect(portWindowsOverlap({ label: 'a', start: 100, count: 10 }, { label: 'b', start: 110, count: 10 })).toBe(false)
  })

  it('an interactive claim stays inside its own window and reports exhaustion there', async () => {
    setInteractivePortWindow(INTERACTIVE)
    const ports: number[] = []
    for (let i = 0; i < INTERACTIVE.count; i++) ports.push(await claim(INTERACTIVE))
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(INTERACTIVE.start)
      expect(p).toBeLessThan(INTERACTIVE.start + INTERACTIVE.count)
    }
    await expect(findPort(INTERACTIVE)).rejects.toThrow(/No available port found in window "interactive"/)
  })

  it('findPort rejects a non-interactive window that overlaps the interactive one', async () => {
    setInteractivePortWindow(INTERACTIVE)
    // No such window ships any more. The refusal is kept armed so that a future one
    // cannot quietly compete for the ports user sessions draw from.
    const overlapping: PortWindow = { label: 'somebody-else', start: INTERACTIVE.start + 5, count: 10 }
    await expect(findPort(overlapping)).rejects.toThrow(/overlaps the interactive window/)
  })

  it('the interactive window itself is never refused against itself', async () => {
    setInteractivePortWindow(INTERACTIVE)
    const port = await claim({ ...INTERACTIVE })
    expect(port).toBeGreaterThanOrEqual(INTERACTIVE.start)
  })

  it('refuses a degenerate window rather than scanning nothing and reporting exhaustion', async () => {
    await expect(findPort({ label: 'x', start: 100, count: 0 })).rejects.toThrow(/Invalid port window/)
  })

  it('registration is readable back, so boot order is observable', () => {
    expect(registeredWindow()).toBeNull()
    setInteractivePortWindow(INTERACTIVE)
    expect(registeredWindow()).toEqual(INTERACTIVE)
  })
})

/** Write a config.json into a throwaway root and load it. */
function loadWith(userConfig: Record<string, unknown>): TinstarConfig {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-cfg-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify(userConfig), 'utf8')
  return loadConfig({ _rootDir: root })
}

describe('retired refresh-worker configuration', () => {
  it('the shipped config declares exactly one port window', () => {
    expect(Object.keys(BASE_CONFIG.ports).sort()).toEqual(['hostCount', 'hostStart', 'ttyd'])
    expect(interactivePortWindow(BASE_CONFIG as unknown as TinstarConfig).label).toBe('interactive')
  })

  it('the shipped refresh slice names no worker cap, timeout, or kill switch', () => {
    // What DOES survive is the attempt bound, the sweep cadence, the default
    // verification interval, and the broker's two budgets — none of which can create
    // anything.
    expect(Object.keys(BASE_CONFIG.refresh).sort()).toEqual([
      'attemptTimeoutMs', 'defaultIntervalMs', 'maxConcurrentLookups',
      'maxConcurrentLookupsPerProvider', 'sweepMs',
    ])
  })

  it('drops a retired refresh port window left in a user config', () => {
    const cfg = loadWith({ ports: { refreshStart: 8801, refreshCount: 40 } })
    expect(cfg.ports).toEqual({ ttyd: BASE_CONFIG.ports.ttyd, hostStart: 8681, hostCount: 100 })
    expect('refreshStart' in cfg.ports).toBe(false)
    expect('refreshCount' in cfg.ports).toBe(false)
  })

  it('drops autonomousWorkers so no config value can reactivate a worker path', () => {
    // The plan's negative test (R19). `true` here used to be the switch that let a
    // trigger fan-out launch background managed sessions; it now lands nowhere.
    const cfg = loadWith({ refresh: { autonomousWorkers: true, maxConcurrentWorkers: 40, workerTimeoutMs: 1 } })
    expect('autonomousWorkers' in cfg.refresh).toBe(false)
    expect('maxConcurrentWorkers' in cfg.refresh).toBe(false)
    expect('workerTimeoutMs' in cfg.refresh).toBe(false)
    expect(cfg.refresh.attemptTimeoutMs).toBe(BASE_CONFIG.refresh.attemptTimeoutMs)
  })

  it('still honours the refresh keys that survive', () => {
    const cfg = loadWith({ refresh: { attemptTimeoutMs: 42_000, sweepMs: 9_000 } })
    expect(cfg.refresh.attemptTimeoutMs).toBe(42_000)
    expect(cfg.refresh.sweepMs).toBe(9_000)
  })
})
