// @vitest-environment node
//
// Switchboard per-session model/token override (Phase 2 Step 5).
// Keystone safety property: when no override is supplied, every seam is
// byte-identical / same-reference to pre-override behavior (inert when unset).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentCommand } from '../backends/tmux'
import { applyTokenOverride } from '../config'
import { createSession, getSession, type CreateSessionOpts } from '../session'

const TEMPLATE = {
  name: 't',
  startCmd: 'claude --model sonnet --session-id {sessionId} -- {prompt}',
  resumeCmd: 'claude --resume {sessionId}',
} as Parameters<typeof buildAgentCommand>[0]['template']

describe('buildAgentCommand — model override', () => {
  const base = {
    template: TEMPLATE,
    sessionId: 'abc',
    initialPrompt: 'hello',
  } as const

  it('is byte-identical when modelOverride is absent', () => {
    const withoutField = buildAgentCommand({ ...base })
    const withNull = buildAgentCommand({ ...base, modelOverride: null })
    expect(withNull).toBe(withoutField)
    // and the override flag is genuinely not present
    expect(withNull).not.toContain('--model opus')
  })

  it('appends --model before the prompt separator when set (template path)', () => {
    const cmd = buildAgentCommand({ ...base, modelOverride: 'opus' })
    // value is single-quoted (injection-safe), mirroring --append-system-prompt
    expect(cmd).toContain("--model 'opus'")
    // inserted before the ` -- ` prompt separator, not after the prompt
    expect(cmd.indexOf("--model 'opus'")).toBeLessThan(cmd.indexOf(' -- '))
  })

  it('appends --model on the legacy (no-template) path', () => {
    const cmd = buildAgentCommand({ sessionId: 'abc', modelOverride: 'opus' })
    expect(cmd).toContain("--model 'opus'")
  })

  it('single-quotes the model value (injection-safe)', () => {
    const cmd = buildAgentCommand({ ...base, modelOverride: "o'pus" })
    expect(cmd).toContain("--model 'o'\\''pus'")
  })
})

describe('applyTokenOverride — secret overlay', () => {
  it('returns the SAME reference when no token is supplied (byte-identical env)', () => {
    const secrets = { FOO: 'bar', CLAUDE_CODE_OAUTH_TOKEN: 'global' }
    expect(applyTokenOverride(secrets, undefined)).toBe(secrets)
    expect(applyTokenOverride(secrets, null)).toBe(secrets)
    expect(applyTokenOverride(secrets, '')).toBe(secrets)
  })

  it('overlays CLAUDE_CODE_OAUTH_TOKEN without mutating the input', () => {
    const secrets = { FOO: 'bar', CLAUDE_CODE_OAUTH_TOKEN: 'global' }
    const out = applyTokenOverride(secrets, 'per-session')
    expect(out).not.toBe(secrets)
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('per-session')
    expect(out.FOO).toBe('bar')
    // input untouched
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe('global')
  })

  it('trims surrounding whitespace before overlaying (matches the validated form)', () => {
    // isPlausibleToken validates token.trim(); applying the raw value would write a
    // space-padded CLAUDE_CODE_OAUTH_TOKEN that fails auth opaquely. The overlay must
    // use the trimmed value so validate-and-apply agree.
    const secrets = { FOO: 'bar' }
    const out = applyTokenOverride(secrets, '  padded-token  ')
    expect(out).not.toBe(secrets)
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('padded-token')
  })

  it('returns the SAME reference for a whitespace-only token (nothing to overlay)', () => {
    const secrets = { FOO: 'bar' }
    expect(applyTokenOverride(secrets, '   ')).toBe(secrets)
  })
})

describe('createSession / getSession — modelOverride persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-override-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const opts = (extra: Partial<CreateSessionOpts> = {}): CreateSessionOpts => ({
    name: 's1', backend: 'tmux', ...extra,
  })

  it('persists modelOverride to session.json when set', () => {
    createSession(dir, opts({ modelOverride: 'opus' }))
    const raw = JSON.parse(readFileSync(join(dir, 's1', 'session.json'), 'utf-8')) as { modelOverride: string | null }
    expect(raw.modelOverride).toBe('opus')
    expect(getSession(dir, 's1')?.modelOverride).toBe('opus')
  })

  it('defaults modelOverride to null when unset', () => {
    createSession(dir, opts())
    expect(getSession(dir, 's1')?.modelOverride).toBeNull()
  })

  it('backfills modelOverride=null for legacy session.json that predates the field', () => {
    createSession(dir, opts())
    // simulate a pre-override persisted session by stripping the field
    const path = join(dir, 's1', 'session.json')
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    delete obj.modelOverride
    writeFileSync(path, JSON.stringify(obj, null, 2))
    expect(getSession(dir, 's1')?.modelOverride).toBeNull()
  })
})
