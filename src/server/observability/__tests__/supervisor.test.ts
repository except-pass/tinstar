import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../supervisor'

let tmp: string

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tinstar-sup-test-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function shSupervisor(script: string, stateDir: string, name = 'fake') {
  const bin = join(tmp, `${name}.sh`)
  writeFileSync(bin, `#!/bin/sh\n${script}\n`)
  chmodSync(bin, 0o755)
  return new Supervisor({
    name,
    binaryPath: bin,
    args: [],
    stateDir,
    port: 9999,
    probe: async () => true,
  })
}

describe('Supervisor spawn + readiness', () => {
  it('spawns the child and reports ready when probe succeeds', async () => {
    const sup = shSupervisor(`sleep 5`, tmp)
    await sup.start()
    expect(sup.state).toBe('ready')
    expect(sup.pid).toBeGreaterThan(0)
    await sup.stop()
  })

  it('marks degraded if readiness probe never succeeds', async () => {
    const bin = join(tmp, 'fake.sh')
    writeFileSync(bin, `#!/bin/sh\nsleep 5\n`)
    chmodSync(bin, 0o755)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => false,
      probeTimeoutMs: 500,
    })
    await sup.start()
    expect(sup.state).toBe('degraded')
    await sup.stop()
  })
})
