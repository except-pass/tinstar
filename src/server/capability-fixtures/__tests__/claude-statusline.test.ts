/**
 * Characterization: what Claude Code's statusline push natively gives us.
 *
 * Runs the frozen fixtures through the REAL ingest path (CcQuotaService) so
 * these tests fail if the derivation changes, not just if the fixture changes.
 * The "native fields" block additionally pins the signals the current pipeline
 * ignores but the provider capability plane will need — losing one of those
 * silently is exactly the regression this layer exists to catch.
 */
import { describe, it, expect } from 'vitest'
import { CcQuotaService } from '../../cc-quota/service'
import { loadClaudeStatusline } from '../index'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const svc = () => new CcQuotaService({ now: () => NOW })

describe('Claude statusline — rate_limits', () => {
  it('normalizes both buckets: used_percentage → utilization, epoch seconds → ISO', () => {
    const snap = svc().ingest(loadClaudeStatusline('statusline-full'))
    expect(snap.data).toEqual({
      five_hour: { utilization: 40, resets_at: '2026-07-30T22:20:00.000Z' },
      seven_day: { utilization: 12, resets_at: '2026-08-02T02:00:00.000Z' },
    })
    expect(snap.error).toBeNull()
  })

  it('an absent rate_limits key is a soft no-op, not an error (pre-first-API session)', () => {
    const s = svc()
    const before = s.getSnapshot()
    const snap = s.ingest(loadClaudeStatusline('statusline-no-rate-limits'))
    expect(snap.data).toBeNull()
    expect(snap.error).toBeNull()
    expect(snap.fetchedAt).toBe(before.fetchedAt) // timestamp deliberately not bumped
  })

  it('a partial rate_limits object yields the present bucket and null for the absent one', () => {
    const snap = svc().ingest(loadClaudeStatusline('statusline-five-hour-only'))
    expect(snap.data?.five_hour).toEqual({ utilization: 55, resets_at: '2026-07-30T22:20:00.000Z' })
    expect(snap.data?.seven_day).toBeNull()
  })

  it('quota survives a payload with no context_window at all', () => {
    const snap = svc().ingest(loadClaudeStatusline('statusline-no-context-window'))
    expect(snap.data?.five_hour?.utilization).toBe(33)
    expect(snap.data?.seven_day?.utilization).toBe(77)
  })
})

describe('Claude statusline — per-session context window', () => {
  it('carves a session-scoped context snapshot out of the same payload', () => {
    const s = svc()
    s.ingest(loadClaudeStatusline('statusline-full'))
    expect(s.getSessionContext('00000000-0000-4000-8000-00000000c1a0')).toEqual({
      usedPercentage: 12,
      windowSize: 1000000,
      fetchedAt: '2026-07-30T12:00:00.000Z',
    })
  })

  it('records context even when rate_limits is absent — the two signals are independent', () => {
    const s = svc()
    s.ingest(loadClaudeStatusline('statusline-no-rate-limits'))
    expect(s.getSnapshot().data).toBeNull()
    expect(s.getSessionContext('00000000-0000-4000-8000-00000000c1a1')).toMatchObject({
      usedPercentage: 4,
      windowSize: 200000,
    })
  })

  it('drops the context snapshot entirely when context_window_size is missing (all-or-nothing)', () => {
    const s = svc()
    s.ingest(loadClaudeStatusline('statusline-partial-context'))
    // used_percentage IS present in this fixture — the derivation still refuses
    // a half-snapshot rather than defaulting the window size.
    expect(loadClaudeStatusline('statusline-partial-context')).toHaveProperty(
      'context_window.used_percentage',
      26,
    )
    expect(s.getSessionContext('00000000-0000-4000-8000-00000000c1a4')).toBeNull()
    expect(s.getSnapshot().data?.five_hour?.utilization).toBe(61) // quota unaffected
  })

  it('has no context snapshot when the payload carries no context_window key', () => {
    const s = svc()
    s.ingest(loadClaudeStatusline('statusline-no-context-window'))
    expect(s.getSessionContext('00000000-0000-4000-8000-00000000c1a3')).toBeNull()
  })

  it('returns null for a session id that never pushed', () => {
    expect(svc().getSessionContext('never-seen')).toBeNull()
  })
})

describe('Claude statusline — native fields not yet consumed', () => {
  // These are pinned, not normalized. The provider plane will need them; if a
  // CC upgrade drops or renames one, this fails loudly instead of silently
  // producing an adapter that reports "--" forever.
  const full = loadClaudeStatusline('statusline-full') as Record<string, never>

  it('identifies the model and CLI version', () => {
    expect(full).toMatchObject({
      model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' },
      version: '2.1.220',
      effort: { level: 'high' },
    })
  })

  it('carries cumulative cost and duration for the session', () => {
    expect(full).toMatchObject({
      cost: {
        total_cost_usd: expect.any(Number),
        total_duration_ms: expect.any(Number),
        total_api_duration_ms: expect.any(Number),
        total_lines_added: expect.any(Number),
        total_lines_removed: expect.any(Number),
      },
    })
  })

  it('carries a token breakdown alongside the used percentage', () => {
    expect(full).toMatchObject({
      context_window: {
        total_input_tokens: expect.any(Number),
        total_output_tokens: expect.any(Number),
        context_window_size: 1000000,
        remaining_percentage: 88,
        current_usage: {
          input_tokens: expect.any(Number),
          output_tokens: expect.any(Number),
          cache_creation_input_tokens: expect.any(Number),
          cache_read_input_tokens: expect.any(Number),
        },
      },
      exceeds_200k_tokens: false,
      fast_mode: false,
      thinking: { enabled: true },
    })
  })

  it('locates the session on disk and in git', () => {
    expect(full).toMatchObject({
      session_id: expect.any(String),
      transcript_path: expect.stringContaining('.jsonl'),
      cwd: '/home/fixture/repo/demo',
      workspace: {
        current_dir: expect.any(String),
        project_dir: expect.any(String),
        git_worktree: 'demo',
        repo: { host: 'github.com', owner: 'fixture-org', name: 'demo' },
      },
    })
  })
})
