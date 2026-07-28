// Port safety for the durable refresh engine (plan U6, "Worker concurrency and
// port safety").
//
// The three scenarios the plan names, and one config guard:
//   · refresh workers never claim a port from the interactive window;
//   · `findPort` rejects a window that overlaps the interactive one;
//   · with the refresh window fully occupied, an interactive claim still succeeds.
//
// `findPort` binds a real loopback listener to test a port, so these tests use
// windows in the ephemeral-ish high range and release everything they claim.
import { describe, it, expect, afterEach } from 'vitest'
import {
  findPort, releasePort, setInteractivePortWindow, interactivePortWindow as registeredWindow,
} from '../backends/tmux'
import {
  portWindowsOverlap, refreshConfigProblem, interactivePortWindow, refreshPortWindow,
  BASE_CONFIG, type PortWindow, type TinstarConfig,
} from '../config'

/** Two windows far from anything the dev machine is likely to be using. */
const INTERACTIVE: PortWindow = { label: 'interactive', start: 19_681, count: 10 }
const REFRESH: PortWindow = { label: 'refresh', start: 19_801, count: 4 }

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

  it('a refresh worker never claims a port from the interactive window', async () => {
    setInteractivePortWindow(INTERACTIVE)
    // Fill the refresh window completely.
    const ports: number[] = []
    for (let i = 0; i < REFRESH.count; i++) ports.push(await claim(REFRESH))
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(REFRESH.start)
      expect(p).toBeLessThan(REFRESH.start + REFRESH.count)
    }
    // The next refresh claim fails INSIDE its own window rather than spilling over.
    await expect(findPort(REFRESH)).rejects.toThrow(/No available port found in window "refresh"/)
  })

  it('an interactive claim still succeeds with every refresh slot occupied', async () => {
    setInteractivePortWindow(INTERACTIVE)
    for (let i = 0; i < REFRESH.count; i++) await claim(REFRESH)
    const port = await claim(INTERACTIVE)
    expect(port).toBeGreaterThanOrEqual(INTERACTIVE.start)
    expect(port).toBeLessThan(INTERACTIVE.start + INTERACTIVE.count)
  })

  it('findPort rejects a non-interactive window that overlaps the interactive one', async () => {
    setInteractivePortWindow(INTERACTIVE)
    const overlapping: PortWindow = { label: 'refresh', start: INTERACTIVE.start + 5, count: 10 }
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

/** A config shaped enough for the two predicates under test. */
function cfg(over: Partial<TinstarConfig['ports']> = {}, refresh: Partial<TinstarConfig['refresh']> = {}): TinstarConfig {
  return {
    ...(BASE_CONFIG as unknown as TinstarConfig),
    ports: { ...BASE_CONFIG.ports, ...over },
    refresh: { ...BASE_CONFIG.refresh, ...refresh },
  }
}

describe('refreshConfigProblem', () => {
  it('accepts the shipped defaults', () => {
    expect(refreshConfigProblem(cfg())).toBeNull()
  })

  it('the shipped cap is comfortably below the refresh window size', () => {
    // The plan's stated invariant, asserted rather than described: workers cannot
    // exhaust their own slice, so they can never be the reason a port runs out.
    expect(BASE_CONFIG.refresh.maxConcurrentWorkers).toBeLessThan(BASE_CONFIG.ports.refreshCount)
  })

  it('the shipped windows are disjoint', () => {
    expect(portWindowsOverlap(interactivePortWindow(cfg()), refreshPortWindow(cfg()))).toBe(false)
  })

  it('refuses overlapping windows', () => {
    expect(refreshConfigProblem(cfg({ refreshStart: 8700 }))).toMatch(/must be disjoint/)
  })

  it('refuses a cap that could exhaust the refresh window', () => {
    expect(refreshConfigProblem(cfg({}, { maxConcurrentWorkers: 40 }))).toMatch(/must stay below ports.refreshCount/)
  })
})
