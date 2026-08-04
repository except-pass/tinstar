// The honest tending stamp for a Slate surface (plan U7, R18/R19).
//
// WHAT IT STOPPED READING IS THE POINT. Until U7 this rendered "updated 3m ago" from
// the record's `amendedAt` — the moment the record was last WRITTEN, which the host
// moves on its own bookkeeping: a generation bump, a source re-observation, a
// freshness commit. So the number under a card reported when the host last touched
// it, not when anyone last checked whether it was still true, and a card nobody had
// verified in a day could truthfully read "updated just now".
//
// It reads `witnessedAt` instead (KTD7): the last revalidation in which every claim
// the surface declared was observed and every one of them held. That timestamp moves
// for exactly one reason — something was checked.
//
// THREE HONEST ANSWERS, and the two that are not durations carry as much as the one
// that is:
//
//   · "checked 3m ago" — a witness ran and every claim held.
//   · "not yet checked" — the surface declares claims and none has been verified yet,
//     so there is NO AGE TO SHOW (R19). Falling back to `amendedAt` here is precisely
//     the lie this component was rewritten to stop telling, which is why the prop is
//     gone rather than optional. Expect a freshly authored card to sit here for one
//     cycle by design: a first look records values but can never stamp a surface
//     witnessed (U3), so a witnessed card always takes two runs.
//   · "nothing to check" — the surface declares no claims at all (`unwitnessed`, R18).
//     A different fact from nobody having got round to it: there is nothing here that
//     COULD be checked, and R18 is explicit that saying so gates no controls and
//     changes no scheduling.
//
// COLOUR (Slate design language, and the discipline stated at the top of
// `FreshnessBadge.tsx`). None of the three states spends a hue on itself. Amber
// appears in exactly one place and it is the place it already appeared — a witnessed
// stamp that has drifted past the 15-minute horizon, which is a "worth a refresh?"
// cue rather than a claim of wrongness. A never-checked card is deliberately NOT
// amber: every claim-bearing card is born there, and a Slate where every card wears a
// warning is a Slate where nobody reads any of them — the same argument that keeps
// `current` silent.
import { relativeAge, isStale } from '../../lib/relativeAge'

/** A surface whose last successful witness is this old draws the eye amber — a
 *  "worth a refresh?" cue, not a claim of wrongness. Far shorter than the Roundup's
 *  24h horizon: a Slate surface is meant to be tended within a working session. */
export const SLATE_STALE_AFTER_MS = 15 * 60_000

/**
 * The bottom-right freshness stamp: mono, low ink, one of three honest answers.
 *
 * BOTH DATA PROPS ARE REQUIRED AND NULLABLE (`T | undefined` rather than `prop?: T`),
 * which is a deliberate use of the type checker rather than a style. This component
 * has three call sites — the expanded card, the collapsed card, and the open-point
 * row — and the open-point row is the one that matters, because every non-objective
 * surface projects as `kind: 'open-point'` and renders through `OpenPointsSurface`.
 * A site that quietly kept reading the old field would have been invisible: its tests
 * would still pass and its cards would still show a plausible number. Optional props
 * would have allowed exactly that. Required-and-nullable makes a missed site a
 * compile error.
 *
 * `now` is passed in (the panel owns ONE ticking clock via `useNow`) so every
 * surface's stamp agrees and there is no timer per row. The helper stays pure: a
 * component that pinned its own `now` would freeze the moment the server stopped
 * sending updates, and a test that pins `now` cannot catch that — which is why the
 * interval lives in the caller and is tested there.
 */
export function SurfaceAge({ witnessedAt, unwitnessed, now, className }: {
  /** Epoch ms of the last revalidation in which every declared claim held.
   *  `undefined` means never witnessed, which is a state and not missing data. */
  witnessedAt: number | undefined
  /** True when the surface declares no claims at all (R18), as derived by
   *  `slateSurfaceFromCanonical`. */
  unwitnessed: boolean | undefined
  now: number
  className?: string
}) {
  const base = ['font-mono text-[10px] leading-none', className].filter(Boolean).join(' ')

  // Nothing declared, so nothing to check. The quietest ink of the three: this is the
  // most resting of the states and it must not read as a problem.
  if (unwitnessed) {
    return (
      <span
        data-testid="surface-age"
        data-witness="unwitnessed"
        title="This surface declares nothing that could prove it wrong, so there is nothing for the host to check."
        className={`${base} text-ink-ctrl`}
      >
        nothing to check
      </span>
    )
  }

  // `relativeAge` already yields '' for a non-finite timestamp, so the NaN guard and
  // the never-witnessed case share one branch — both mean "there is no age here".
  const age = relativeAge(witnessedAt ?? Number.NaN, now)
  if (!age) {
    return (
      <span
        data-testid="surface-age"
        data-witness="never"
        title="This surface declares what would prove it wrong, but nobody has checked it yet."
        className={`${base} text-slate-500`}
      >
        not yet checked
      </span>
    )
  }

  const stale = isStale(witnessedAt ?? Number.NaN, now, SLATE_STALE_AFTER_MS)
  return (
    <span
      data-testid="surface-age"
      data-witness="witnessed"
      data-stale={stale ? 'true' : undefined}
      title={stale
        ? 'Its claims have not been checked in a while — refresh to re-verify them'
        : `every claim checked and held ${age}`}
      className={`${base} ${stale ? 'text-amber-400/80' : 'text-slate-500'}`}
    >
      checked {age}
    </span>
  )
}
