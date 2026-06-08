import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateNatsMcpConfig, natsTopicsFilePath } from '../tmux'
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

  function workspace(name: string): string {
    const ws = join(root, 'ws-' + name)
    mkdirSync(ws, { recursive: true })
    return ws
  }

  it('writes a .mcp.json that is byte-identical across different sessions (no churn)', () => {
    const a = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', workspacePath: workspace('a'), nats: nats(['tinstar.s._._.alpha']), ...COMMON })
    const b = generateNatsMcpConfig({ sessionsDir, sessionName: 'bravo', workspacePath: workspace('b'), nats: nats(['tinstar.s._._.bravo', 'tinstar.s._._.bravo.x']), ...COMMON })
    // Different session names + different subscription counts, yet the same bytes.
    expect(readFileSync(a, 'utf-8')).toBe(readFileSync(b, 'utf-8'))
  })

  it('keeps per-session values out of .mcp.json (env tokens only)', () => {
    const p = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', workspacePath: workspace('a'), nats: nats(['tinstar.s._._.alpha']), ...COMMON })
    const text = readFileSync(p, 'utf-8')
    expect(text).not.toContain('alpha')
    expect(text).toContain('${TINSTAR_SESSION_NAME}')
    expect(text).toContain('${TINSTAR_NATS_TOPICS_FILE}')
    expect(text).toContain('${TINSTAR_NATS_CONTROL_SOCKET}')
    // The variable-length subscription list is NOT inlined as --subscribe args.
    expect(text).not.toContain('--subscribe')
    expect(text).toContain('--topics-file')
  })

  it('writes the per-session subscriptions to the topics file (one per line)', () => {
    generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', workspacePath: workspace('a'), nats: nats(['a.b.c', 'a.b.c.d']), ...COMMON })
    expect(readFileSync(natsTopicsFilePath(sessionsDir, 'alpha'), 'utf-8')).toBe('a.b.c\na.b.c.d\n')
  })

  it('is idempotent — re-running with unchanged content does not rewrite the file', () => {
    const ws = workspace('a')
    const p = generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', workspacePath: ws, nats: nats(['a.b.c']), ...COMMON })
    const mtime1 = statSync(p).mtimeMs
    // Force a detectable gap, then regenerate identical content.
    writeFileSync(join(root, 'touch'), 'x')
    generateNatsMcpConfig({ sessionsDir, sessionName: 'alpha', workspacePath: ws, nats: nats(['a.b.c']), ...COMMON })
    expect(statSync(p).mtimeMs).toBe(mtime1)
  })
})
