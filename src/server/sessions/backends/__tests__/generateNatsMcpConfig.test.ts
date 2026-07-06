import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateNatsMcpConfig, natsTopicsFilePath, natsControlSocketPath } from '../tmux'
import type { SessionNats } from '../../session'

function nats(subs: string[]): SessionNats {
  return { enabled: true, subscriptions: subs }
}

const COMMON = {
  channelServerPackage: 'github:except-pass/nats-channel-mcp',
  bunPath: '/home/ubuntu/.bun/bin/bun',
}

describe('generateNatsMcpConfig', () => {
  let root: string
  let sessionsDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tinstar-mcp-'))
    sessionsDir = join(root, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('writes to the per-session config dir, not any git workspace, and returns that path', () => {
    const p = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['a.b.c']), ...COMMON })
    // Returned path is the per-session nats-mcp.json under sessionsDir.
    expect(p).toBe(join(sessionsDir, 'alpha', 'nats-mcp.json'))
    expect(statSync(p).isFile()).toBe(true)
  })

  it('bakes literal per-session values (no ${VAR} tokens, no repo dependence)', () => {
    const p = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['tinstar.s._._.alpha']), ...COMMON })
    const text = readFileSync(p, 'utf-8')
    // Literal name + literal per-session paths, not env tokens.
    expect(text).toContain('"--name"')
    expect(text).toContain('alpha')
    expect(text).toContain(natsTopicsFilePath(sessionsDir, 'alpha'))
    expect(text).toContain(natsControlSocketPath('alpha'))
    expect(text).not.toContain('${TINSTAR_SESSION_NAME}')
    expect(text).not.toContain('${TINSTAR_NATS_TOPICS_FILE}')
    expect(text).not.toContain('${TINSTAR_NATS_CONTROL_SOCKET}')
    // The variable-length subscription list is NOT inlined as --subscribe args.
    expect(text).not.toContain('--subscribe')
    expect(text).toContain('--topics-file')
  })

  it('produces different bytes per session (per-session file, no cross-session churn concern)', () => {
    const a = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['tinstar.s._._.alpha']), ...COMMON })
    const b = generateNatsMcpConfig({ sessionsDir, sessionName: 'bravo', nats: nats(['tinstar.s._._.bravo']), ...COMMON })
    // Distinct sessions → distinct files with their own literal identities.
    expect(a).not.toBe(b)
    expect(readFileSync(a, 'utf-8')).not.toBe(readFileSync(b, 'utf-8'))
  })

  it('includes --jetstream only when requested', () => {
    const off = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['a.b.c']), ...COMMON })
    expect(readFileSync(off, 'utf-8')).not.toContain('--jetstream')
    const on = generateNatsMcpConfig({ sessionsDir, sessionName: 'bravo', nats: nats(['a.b.c']), jetstream: true, ...COMMON })
    expect(readFileSync(on, 'utf-8')).toContain('--jetstream')
  })

  it('writes the per-session subscriptions to the topics file (one per line)', () => {
    generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['a.b.c', 'a.b.c.d']), ...COMMON })
    expect(readFileSync(natsTopicsFilePath(sessionsDir, 'alpha'), 'utf-8')).toBe('a.b.c\na.b.c.d\n')
  })

  it('is idempotent — re-running with unchanged content does not rewrite the file', () => {
    const p = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['a.b.c']), ...COMMON })
    const mtime1 = statSync(p).mtimeMs
    // Force a detectable gap, then regenerate identical content.
    writeFileSync(join(root, 'touch'), 'x')
    generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', nats: nats(['a.b.c']), ...COMMON })
    expect(statSync(p).mtimeMs).toBe(mtime1)
  })
})
