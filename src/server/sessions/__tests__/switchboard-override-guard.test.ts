// @vitest-environment node
//
// Switchboard per-session override startup guard (Phase 2 Step 6).
// Security invariant: the override is FAIL-CLOSED — rejected with a stable error
// code unless explicitly permitted by config; the token value never appears in a
// returned message.
import { describe, it, expect } from 'vitest'
import { validateSessionOverride } from '../config'

const DISABLED = { allowedModels: [], allowTokenOverride: false }
const MODELS_OK = { allowedModels: ['opus', 'sonnet'], allowTokenOverride: false }
const TOKEN_OK = { allowedModels: [], allowTokenOverride: true }
const PLAUSIBLE_TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40)

describe('validateSessionOverride — model guard', () => {
  it('passes when neither override is present (inert path)', () => {
    expect(validateSessionOverride({}, DISABLED)).toEqual({ ok: true })
    expect(validateSessionOverride({ model: null, token: null }, DISABLED)).toEqual({ ok: true })
    expect(validateSessionOverride({ model: '', token: '' }, DISABLED)).toEqual({ ok: true })
  })

  it('rejects a model override when no allowlist is configured (fail-closed)', () => {
    const r = validateSessionOverride({ model: 'opus' }, DISABLED)
    expect(r).toEqual({ ok: false, code: 'OVERRIDE_MODEL_NOT_CONFIGURED', message: expect.any(String) })
  })

  it('rejects a model not in the allowlist', () => {
    const r = validateSessionOverride({ model: 'haiku' }, MODELS_OK)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('OVERRIDE_MODEL_NOT_ALLOWED')
  })

  it('passes a model that is in the allowlist', () => {
    expect(validateSessionOverride({ model: 'opus' }, MODELS_OK)).toEqual({ ok: true })
  })
})

describe('validateSessionOverride — token guard', () => {
  it('rejects a token override when the master switch is off (fail-closed)', () => {
    const r = validateSessionOverride({ token: PLAUSIBLE_TOKEN }, DISABLED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('OVERRIDE_TOKEN_DISABLED')
  })

  it('rejects a malformed token even when enabled', () => {
    for (const bad of ['short', 'has white space ' + 'x'.repeat(30), '']) {
      const r = validateSessionOverride({ token: bad }, TOKEN_OK)
      // empty string is treated as "no override" → ok; non-empty malformed → rejected
      if (bad === '') {
        expect(r).toEqual({ ok: true })
      } else {
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.code).toBe('OVERRIDE_TOKEN_MALFORMED')
      }
    }
  })

  it('passes a plausible token when enabled', () => {
    expect(validateSessionOverride({ token: PLAUSIBLE_TOKEN }, TOKEN_OK)).toEqual({ ok: true })
  })

  it('rejects a non-string token as malformed without throwing (JSON can yield a number)', () => {
    // The token comes from JSON.parse, so a caller could send {"token": 42}. It must
    // reject cleanly, not throw on isPlausibleToken's .trim().
    const r = validateSessionOverride({ token: 42 as unknown as string }, TOKEN_OK)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('OVERRIDE_TOKEN_MALFORMED')
  })

  it('NEVER includes the token value in the rejection message', () => {
    const secret = 'sk-ant-oat01-SUPERSECRETVALUE' + 'z'.repeat(20)
    // malformed (contains whitespace) so it is rejected
    const r = validateSessionOverride({ token: secret + ' trailing' }, TOKEN_OK)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).not.toContain('SUPERSECRET')
      expect(r.message).not.toContain(secret)
    }
  })
})
