// @vitest-environment jsdom
//
// The honest tending stamp (plan U7, R18/R19). Three states a reader must be able to
// tell apart: a surface someone checked, one whose claims nobody has checked yet, and
// one that declares nothing anybody COULD check.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { render, screen, cleanup } from '@testing-library/react'
import { SurfaceAge, SLATE_STALE_AFTER_MS } from '../SurfaceAge'

const NOW = 1_000_000_000_000

afterEach(cleanup)

describe('SurfaceAge — a witnessed surface', () => {
  it('reports the WITNESS age, humanized, and is not stale', () => {
    render(<SurfaceAge witnessedAt={NOW - 3 * 60_000} unwitnessed={false} now={NOW} />)
    const el = screen.getByTestId('surface-age')
    expect(el.textContent).toBe('checked 3m ago')
    expect(el.dataset.witness).toBe('witnessed')
    expect(el.getAttribute('data-stale')).toBeNull()
  })

  it('reads "just now" under a minute', () => {
    render(<SurfaceAge witnessedAt={NOW - 5_000} unwitnessed={false} now={NOW} />)
    expect(screen.getByTestId('surface-age').textContent).toBe('checked just now')
  })

  it('ambers past the session horizon — the ONE hue this component spends', () => {
    render(<SurfaceAge witnessedAt={NOW - (SLATE_STALE_AFTER_MS + 60_000)} unwitnessed={false} now={NOW} />)
    const el = screen.getByTestId('surface-age')
    expect(el.getAttribute('data-stale')).toBe('true')
    expect(el.className).toContain('amber')
  })
})

describe('SurfaceAge — never witnessed (R19)', () => {
  // AE6. The whole point of U7: `undefined` is a STATE, not missing data, and the
  // honest render of it carries no duration at all.
  it('shows NO AGE — a label, never a number', () => {
    render(<SurfaceAge witnessedAt={undefined} unwitnessed={false} now={NOW} />)
    const el = screen.getByTestId('surface-age')
    expect(el.textContent).toBe('not yet checked')
    expect(el.dataset.witness).toBe('never')
    expect(el.textContent).not.toMatch(/ago|just now/)
  })

  it('renders the same for a non-finite timestamp — no "NaN ago"', () => {
    render(<SurfaceAge witnessedAt={Number.NaN} unwitnessed={false} now={NOW} />)
    expect(screen.getByTestId('surface-age').textContent).toBe('not yet checked')
  })

  // A first look records values but can never stamp a surface witnessed (U3), so a
  // freshly authored card sits in this state for a full cycle by design. Amber here
  // would light up every new card on the Slate.
  it('is not amber: every claim-bearing card is BORN here', () => {
    render(<SurfaceAge witnessedAt={undefined} unwitnessed={false} now={NOW} />)
    expect(screen.getByTestId('surface-age').className).not.toContain('amber')
  })
})

describe('SurfaceAge — claimless (R18)', () => {
  it('says there is nothing to check, and says it differently from "not yet checked"', () => {
    render(<SurfaceAge witnessedAt={undefined} unwitnessed now={NOW} />)
    const claimless = screen.getByTestId('surface-age')
    const claimlessText = claimless.textContent
    const claimlessClass = claimless.className
    expect(claimlessText).toBe('nothing to check')
    expect(claimless.dataset.witness).toBe('unwitnessed')
    cleanup()

    render(<SurfaceAge witnessedAt={undefined} unwitnessed={false} now={NOW} />)
    const never = screen.getByTestId('surface-age')
    expect(never.textContent).not.toBe(claimlessText)
    expect(never.className).not.toBe(claimlessClass)
  })

  // KTD1/KTD4: both empty claim states project `unwitnessed`, and neither may borrow
  // a witness timestamp from anywhere. A stale `witnessedAt` left on the record of a
  // surface whose claims were since deleted must not resurrect as an age.
  it('wins over any timestamp still on the record', () => {
    render(<SurfaceAge witnessedAt={NOW - 60_000} unwitnessed now={NOW} />)
    expect(screen.getByTestId('surface-age').textContent).toBe('nothing to check')
  })

  it('spends no hue at all — the most resting of the three states', () => {
    render(<SurfaceAge witnessedAt={undefined} unwitnessed now={NOW} />)
    const cls = screen.getByTestId('surface-age').className
    expect(cls).not.toContain('amber')
    expect(cls).not.toContain('text-primary')
  })
})

// Scenario 7. The type checker already forbids a call site passing `amendedAt` — the
// prop does not exist — but it CANNOT forbid a future site passing
// `witnessedAt={surface.amendedAt}`, which is the same mistake with a symptom that is
// a plausible-looking number rather than a crash. So the expressions themselves are
// compared: every call site must read the same thing, and that thing must not be the
// record's last-written time.
describe('every SurfaceAge call site reads the same field', () => {
  const dir = resolve(process.cwd(), 'src/components/RunWorkspaceWidget')

  function callSites(): { file: string; witnessedAt: string; unwitnessed: string }[] {
    const out: { file: string; witnessedAt: string; unwitnessed: string }[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tsx') || name === 'SurfaceAge.tsx') continue
      const src = readFileSync(join(dir, name), 'utf8')
      for (const m of src.matchAll(/<SurfaceAge\b([^>]*?)\/>/gs)) {
        const props = m[1]!
        out.push({
          file: name,
          witnessedAt: /witnessedAt=\{([^}]*)\}/.exec(props)?.[1]?.trim() ?? '(missing)',
          unwitnessed: /unwitnessed=\{([^}]*)\}/.exec(props)?.[1]?.trim() ?? '(missing)',
        })
      }
    }
    return out
  }

  it('finds all three sites — two on the card shell, one on the open-point row', () => {
    const sites = callSites()
    expect(sites).toHaveLength(3)
    // The open-point row is the one that matters: every non-objective surface
    // projects as `kind: 'open-point'`, so a change made only in SlatePanel is
    // invisible for exactly the surfaces this feature is about.
    expect(sites.filter(s => s.file === 'OpenPointsSurface.tsx')).toHaveLength(1)
    expect(sites.filter(s => s.file === 'SlatePanel.tsx')).toHaveLength(2)
  })

  it('every site passes the SAME two expressions, and neither is amendedAt', () => {
    const sites = callSites()
    expect(new Set(sites.map(s => s.witnessedAt)).size).toBe(1)
    expect(new Set(sites.map(s => s.unwitnessed)).size).toBe(1)
    for (const site of sites) {
      expect(site.witnessedAt).toBe('surface.freshness?.witnessedAt')
      expect(site.unwitnessed).toBe('surface.unwitnessed')
    }
  })
})
