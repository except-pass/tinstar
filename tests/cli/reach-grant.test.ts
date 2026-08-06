import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUnit } from '../../bin/tinstar/commands/service.js'
import {
  REACH_SUDOERS_PATH,
  buildReachSudoersRule,
  describeReachGrant,
  grantPermits,
  reachGrantCommands,
  unitNeedsRegeneration,
} from '../../bin/tinstar/reachGrant.js'
import {
  TAILSCALE_BIN,
  serveEstablishArgv,
  serveRevokeArgv,
} from '../../src/server/reach/tailscale'

const RULE = buildReachSudoersRule({
  user: 'will',
  tailscalePath: '/usr/bin/tailscale',
  port: 5273,
})

describe('the scoped sudoers grant', () => {
  it('permits exactly the two serve invocations Tinstar issues', () => {
    expect(grantPermits(RULE, '/usr/bin/tailscale serve --bg --yes --https=443 http://127.0.0.1:5273')).toBe(true)
    expect(grantPermits(RULE, '/usr/bin/tailscale serve --bg --yes --https=443 off')).toBe(true)
  })

  it('refuses every other provider subcommand', () => {
    // The blast radius must be serve-shaped, not daemon-shaped.
    for (const argv of [
      '/usr/bin/tailscale up',
      '/usr/bin/tailscale down',
      '/usr/bin/tailscale logout',
      '/usr/bin/tailscale set --operator=will',
      '/usr/bin/tailscale funnel 5273',
      '/usr/bin/tailscale serve reset',
      '/usr/bin/tailscale serve --bg --yes --https=443 http://127.0.0.1:22',
    ]) {
      expect(grantPermits(RULE, argv)).toBe(false)
    }
  })

  it('carries no wildcard and no other binary path', () => {
    expect(RULE).not.toContain('*')
    expect(RULE).not.toContain('ALL=(ALL) NOPASSWD: ALL')
    for (const line of RULE.split('\n')) {
      if (!line.includes('NOPASSWD')) continue
      expect(line).toContain('/usr/bin/tailscale')
    }
  })

  it('never grants the daemon-wide operator flag', () => {
    // Chosen against deliberately: --operator confers control of the whole
    // daemon and is the pivot in one of the advisories this work gates on.
    expect(RULE).not.toContain('--operator')
  })

  it('runs without a password, because revoke and repair are unattended', () => {
    // Revoke runs at shutdown and repair at boot, both with nobody to answer a
    // prompt. A grant that can prompt is itself the failure mode.
    expect(RULE).toContain('NOPASSWD:')
  })

  it('names the invoking user, not ALL', () => {
    expect(RULE.startsWith('will ')).toBe(true)
    expect(RULE).not.toMatch(/^ALL\s/m)
  })

  it('is scoped to one port, and says so', () => {
    const other = buildReachSudoersRule({
      user: 'will',
      tailscalePath: '/usr/bin/tailscale',
      port: 5274,
    })
    expect(grantPermits(other, '/usr/bin/tailscale serve --bg --yes --https=443 http://127.0.0.1:5273')).toBe(false)
    expect(describeReachGrant({ user: 'will', tailscalePath: '/usr/bin/tailscale', port: 5273 }))
      .toMatch(/port/i)
  })

  it('lives in a drop-in, never in the main sudoers file', () => {
    expect(REACH_SUDOERS_PATH).toBe('/etc/sudoers.d/tinstar-reach')
  })
})

describe('describeReachGrant — the operator sees it before it is written', () => {
  it('includes the literal rule text', () => {
    // This is a root-adjacent rule on a machine running autonomous agents. It
    // should never appear without the operator having read it.
    const description = describeReachGrant({
      user: 'will',
      tailscalePath: '/usr/bin/tailscale',
      port: 5273,
    })
    expect(description).toContain(RULE)
    expect(description).toContain(REACH_SUDOERS_PATH)
  })

  it('says what the grant does NOT permit', () => {
    const description = describeReachGrant({
      user: 'will',
      tailscalePath: '/usr/bin/tailscale',
      port: 5273,
    }).toLowerCase()
    expect(description).toMatch(/no other|nothing else|only/)
  })
})

describe('unitNeedsRegeneration — the pre-change systemd unit', () => {
  const LEGACY = `[Service]
Environment=TINSTAR_CORS_ORIGINS=tauri://localhost,http://localhost:5273
ExecStart=/bin/bash -c 'exec node bin/tinstar.js --port 5273 --host 127.0.0.1 --host $(/usr/bin/tailscale ip --4 | head -n1)'
`

  it('detects a unit that pins a tailnet address', () => {
    const verdict = unitNeedsRegeneration(LEGACY)
    expect(verdict.needsRegeneration).toBe(true)
    expect(verdict.reasons.join(' ')).toMatch(/tailscale ip|tailnet/i)
  })

  it('detects a unit that builds a CORS allowlist at install time', () => {
    expect(unitNeedsRegeneration(LEGACY).reasons.join(' ')).toMatch(/cors/i)
  })

  it('passes a unit generated after the change', () => {
    const current = `[Service]
ExecStart=/bin/bash -c 'exec node bin/tinstar.js --port 5273 --no-open'
`
    expect(unitNeedsRegeneration(current).needsRegeneration).toBe(false)
  })

  it('treats a missing unit as nothing to regenerate', () => {
    expect(unitNeedsRegeneration(null).needsRegeneration).toBe(false)
  })
})

describe('the generated systemd unit', () => {
  const unit = buildUnit({
    repoRoot: '/home/will/repo/tinstar',
    nodePath: '/usr/bin/node',
    port: 5273,
    extraPathDirs: ['/home/will/.local/bin'],
  }) as string

  it('pins no tailnet address', () => {
    // The old unit resolved `tailscale ip --4` into --host at every start,
    // which re-opens exactly the bind containment closed.
    expect(unit).not.toContain('tailscale ip')
    expect(unit).not.toContain('--host')
  })

  it('freezes no CORS allowlist at install time', () => {
    // The server seeds the allowlist at bind now, and reach registers its own
    // origin. An install-time list would go stale the moment either moved.
    expect(unit).not.toContain('TINSTAR_CORS_ORIGINS')
  })

  it('still starts the server on the configured port', () => {
    expect(unit).toContain('--port 5273')
    expect(unit).toContain('/home/will/repo/tinstar/bin/tinstar.js')
  })

  it('is not itself flagged as needing regeneration', () => {
    expect(unitNeedsRegeneration(unit).needsRegeneration).toBe(false)
  })
})

describe('the grant covers exactly what the adapter runs', () => {
  it('matches the establish and revoke command lines byte for byte', () => {
    // sudoers matches the WHOLE command line. One extra flag on either side and
    // the grant stops applying, which surfaces as a bare permission refusal
    // with nothing pointing at the drift that caused it. This test is the
    // only thing tying the plain-JS grant to the TypeScript adapter.
    const port = 5273
    expect(reachGrantCommands({ tailscalePath: TAILSCALE_BIN, port })).toEqual([
      [TAILSCALE_BIN, ...serveEstablishArgv(port)].join(' '),
      [TAILSCALE_BIN, ...serveRevokeArgv({ port, url: 'https://x' })].join(' '),
    ])
  })

  it('grants exactly the two lines the adapter can issue, and nothing more', () => {
    const rule = buildReachSudoersRule({
      user: 'will',
      tailscalePath: TAILSCALE_BIN,
      port: 5273,
    })
    expect(grantPermits(rule, [TAILSCALE_BIN, ...serveEstablishArgv(5273)].join(' '))).toBe(true)
    expect(grantPermits(
      rule,
      [TAILSCALE_BIN, ...serveRevokeArgv({ port: 5273, url: 'https://x' })].join(' '),
    )).toBe(true)
  })
})

/** visudo -cf parses a file without touching the live sudoers config. */
function visudoAvailable(): boolean {
  for (const bin of ['/usr/sbin/visudo', '/sbin/visudo', 'visudo']) {
    try {
      execFileSync(bin, ['-V'], { stdio: 'ignore' })
      return true
    } catch { /* try the next path */ }
  }
  return false
}

function visudoCheck(rule: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tinstar-sudoers-'))
  const file = join(dir, 'tinstar-reach')
  try {
    writeFileSync(file, `${rule}\n`, { mode: 0o600 })
    for (const bin of ['/usr/sbin/visudo', '/sbin/visudo', 'visudo']) {
      try {
        execFileSync(bin, ['-cf', file], { stdio: 'pipe' })
        return { ok: true, output: '' }
      } catch (err) {
        const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer }
        // A missing binary is not a parse failure — keep looking.
        if (e.status === undefined) continue
        return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
      }
    }
    return { ok: false, output: 'visudo not found' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the generated rule parses as real sudoers', () => {
  const realIt = visudoAvailable() ? it : it.skip

  realIt('is accepted by visudo -c', () => {
    // grantPermits models sudoers matching; it is not sudoers. The command
    // lines carry `=` and `:`, which sudoers(5) lists among characters needing
    // escaping — so "my matcher likes it" is not evidence the parser does.
    // A drop-in that fails to parse locks every user out of sudo.
    const verdict = visudoCheck(RULE)
    expect(verdict.output).toBe('')
    expect(verdict.ok).toBe(true)
  })

  realIt('rejects a malformed rule, so the check above is not vacuous', () => {
    // Without this, a visudo that accepted everything would make the test above
    // pass for the wrong reason. NB `will ALL=(root) NOPASSWD` is NOT a usable
    // fixture: visudo parses it as a Cmnd_Alias reference and exits 0.
    expect(visudoCheck('will ALL=(root').ok).toBe(false)
  })

  realIt('rejects the unescaped form, which is what shipped before', () => {
    // The colon in `http://127.0.0.1:5273` is the sudoers list separator. This
    // is the concrete reason the grant could never have installed.
    expect(visudoCheck(
      'will ALL=(root) NOPASSWD: /usr/bin/tailscale serve --bg --yes --https=443 http://127.0.0.1:5273',
    ).ok).toBe(false)
  })
})
