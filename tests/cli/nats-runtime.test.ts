import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBunPath, countNatsSessions, describeMissingBun, probeBun } from '../../bin/natsRuntime.js'

let root: string
const savedConfigHome = process.env.TINSTAR_CONFIG_HOME

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-nats-runtime-'))
  process.env.TINSTAR_CONFIG_HOME = root
})

afterEach(() => {
  if (savedConfigHome === undefined) delete process.env.TINSTAR_CONFIG_HOME
  else process.env.TINSTAR_CONFIG_HOME = savedConfigHome
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(cfg: unknown) {
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg))
}

function makeSession(name: string, opts: { nats: boolean }) {
  const dir = join(root, 'sessions', name)
  mkdirSync(dir, { recursive: true })
  if (opts.nats) writeFileSync(join(dir, 'nats-mcp.json'), '{}')
}

describe('resolveBunPath', () => {
  it('defaults to ~/.bun/bin/bun — the same default the server config uses', () => {
    expect(resolveBunPath()).toBe(join(homedir(), '.bun/bin/bun'))
  })

  it('honors nats.bunPath from config.json', () => {
    writeConfig({ nats: { bunPath: '/opt/bun/bin/bun' } })
    expect(resolveBunPath()).toBe('/opt/bun/bin/bun')
  })

  it('falls back to the default when config.json is unparseable', () => {
    writeFileSync(join(root, 'config.json'), '{ not json')
    expect(resolveBunPath()).toBe(join(homedir(), '.bun/bin/bun'))
  })

  it('ignores a blank bunPath rather than probing the empty string', () => {
    writeConfig({ nats: { bunPath: '' } })
    expect(resolveBunPath()).toBe(join(homedir(), '.bun/bin/bun'))
  })
})

describe('countNatsSessions', () => {
  it('counts only sessions carrying a generated nats-mcp.json', () => {
    makeSession('alpha', { nats: true })
    makeSession('beta', { nats: false })
    makeSession('gamma', { nats: true })
    expect(countNatsSessions()).toBe(2)
  })

  it('returns 0 when no sessions dir exists yet', () => {
    expect(countNatsSessions()).toBe(0)
  })
})

describe('probeBun', () => {
  it('reports not-found for a configured path that does not exist', () => {
    writeConfig({ nats: { bunPath: join(root, 'nope', 'bun') } })
    const probe = probeBun()
    expect(probe.ok).toBe(false)
    expect(probe.reason).toBe('not found')
    expect(probe.path).toContain('nope')
  })

  it('reports not-runnable for a path that exists but cannot exec', () => {
    const fake = join(root, 'bun')
    writeFileSync(fake, 'not a binary', { mode: 0o644 })
    writeConfig({ nats: { bunPath: fake } })
    const probe = probeBun()
    expect(probe.ok).toBe(false)
    expect(probe.reason).toContain('not runnable')
  })
})

describe('describeMissingBun', () => {
  it('escalates the wording once sessions actually depend on NATS', () => {
    expect(describeMissingBun({ natsSessions: 0 })).toContain('will fail')
    expect(describeMissingBun({ natsSessions: 1 })).toContain('1 session uses NATS')
    expect(describeMissingBun({ natsSessions: 3 })).toContain('3 sessions use NATS')
  })
})
