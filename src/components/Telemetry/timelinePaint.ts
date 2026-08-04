import { BAND_KINDS, type BandKind } from '../../domain/types'
import type { Band } from '../../server/sessions/timeline/types'

const KI_APPROVAL = BAND_KINDS.indexOf('approval')
const KI_QUESTION = BAND_KINDS.indexOf('question')

/**
 * Award each pixel along the strip to one band kind.
 *
 * Occupancy decides, so a strip's colour proportions match the percentages
 * printed beside it (R17). Awarding by priority instead made a 73%-idle session
 * read as busy, because any pixel containing a single tool call went to `tool`.
 *
 * The two "waiting on you" kinds are the exception. At rail scale one pixel is
 * minutes to tens of minutes, so a four-second approval would be averaged into
 * invisibility — and that band is the entire reason this chart exists (R11).
 *
 * `px` is the strip's long axis in device-independent pixels. The strip is
 * rendered vertically, so a "column" here is a row of the canvas: index 0 is the
 * earliest moment, which puts the past at the top (R9).
 */
/** Where each band sits along the strip, in pixels. */
export interface BandLayout {
  /** Start offset per band. */
  pos: Float64Array
  /** Length per band. */
  len: Float64Array
  /** BAND_KINDS index per band. */
  kind: Int8Array
}

/** Bands in time order, positioned proportionally — the honest picture. */
export function timelineLayout(bands: Band[], t0: number, t1: number, px: number): BandLayout {
  const span = Math.max(t1 - t0, 1e-9)
  const n = bands.length
  const out: BandLayout = { pos: new Float64Array(n), len: new Float64Array(n), kind: new Int8Array(n) }
  for (let i = 0; i < n; i++) {
    const b = bands[i]!
    out.pos[i] = ((b.start - t0) / span) * px
    out.len[i] = ((b.end - b.start) / span) * px
    out.kind[i] = BAND_KINDS.indexOf(b.kind)
  }
  return out
}

/**
 * Bands regrouped by kind, laid end to end — the mix, with time discarded.
 *
 * Kinds keep BAND_KINDS order and bands keep their chronological order within a
 * kind, so the transition between layouts is a stable rearrangement: every band
 * has one destination and like slides to like.
 */
export function percentLayout(bands: Band[], px: number): BandLayout {
  const n = bands.length
  const out: BandLayout = { pos: new Float64Array(n), len: new Float64Array(n), kind: new Int8Array(n) }
  let total = 0
  for (let i = 0; i < n; i++) {
    const b = bands[i]!
    out.kind[i] = BAND_KINDS.indexOf(b.kind)
    out.len[i] = b.end - b.start
    total += out.len[i]!
  }
  const scale = px / Math.max(total, 1e-9)
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (out.kind[a]! - out.kind[b]!) || a - b)
  let acc = 0
  for (const i of order) {
    out.pos[i] = acc
    out.len[i] = out.len[i]! * scale
    acc += out.len[i]!
  }
  return out
}

/**
 * Award each pixel from an explicit pixel layout.
 *
 * Split out from `compositeColumns` so the same occupancy rule serves both
 * layouts and every frame of the transition between them — the rule must not
 * change mid-animation or bands would flicker colour as they move.
 */
export function compositeLayout(layout: BandLayout, px: number): (BandKind | null)[] {
  const nk = BAND_KINDS.length
  const acc = new Float64Array(px * nk)
  const n = layout.kind.length

  for (let i = 0; i < n; i++) {
    const ki = layout.kind[i]!
    if (ki < 0) continue
    const x = layout.pos[i]!
    const x2 = x + layout.len[i]!
    let a = Math.floor(x)
    let z = Math.ceil(x2)
    if (z <= a) z = a + 1
    if (a < 0) a = 0
    if (z > px) z = px
    for (let c = a; c < z; c++) {
      const ov = Math.min(x2, c + 1) - Math.max(x, c)
      // A band thinner than a pixel still registers, just with negligible
      // weight — enough for the override below to see it.
      acc[c * nk + ki]! += ov > 0 ? ov : 1e-9
    }
  }

  const out: (BandKind | null)[] = new Array<BandKind | null>(px).fill(null)
  for (let c = 0; c < px; c++) {
    const base = c * nk
    let best = -1
    let bestV = 0
    for (let k = 0; k < nk; k++) {
      const v = acc[base + k]!
      if (v > bestV) { bestV = v; best = k }
    }
    if (acc[base + KI_APPROVAL]! > 0) best = KI_APPROVAL
    else if (acc[base + KI_QUESTION]! > 0) best = KI_QUESTION
    out[c] = best < 0 ? null : BAND_KINDS[best]!
  }
  return out
}

/** Convenience: composite bands in time order. */
export function compositeColumns(bands: Band[], t0: number, t1: number, px: number): (BandKind | null)[] {
  return compositeLayout(timelineLayout(bands, t0, t1, px), px)
}

/** Blend two layouts of the same bands — the frame-by-frame transition. */
export function lerpLayout(a: BandLayout, b: BandLayout, p: number): BandLayout {
  const n = a.kind.length
  const out: BandLayout = { pos: new Float64Array(n), len: new Float64Array(n), kind: a.kind }
  for (let i = 0; i < n; i++) {
    out.pos[i] = a.pos[i]! + (b.pos[i]! - a.pos[i]!) * p
    out.len[i] = a.len[i]! + (b.len[i]! - a.len[i]!) * p
  }
  return out
}

export interface ColumnRun { kind: BandKind; start: number; len: number }

/**
 * Collapse the column array into runs of equal colour.
 *
 * Drawing one rectangle per band pinned the spike's mode transition at 7fps —
 * roughly a thousand `fillRect` calls per strip per frame. Emitting runs lets
 * the caller issue one filled path per colour instead (R16).
 */
export function runsFromColumns(cols: (BandKind | null)[]): ColumnRun[] {
  const out: ColumnRun[] = []
  let start = 0
  let cur = cols.length > 0 ? cols[0]! : null
  for (let c = 1; c <= cols.length; c++) {
    const k = c < cols.length ? cols[c]! : null
    if (k === cur && c < cols.length) continue
    if (cur !== null) out.push({ kind: cur, start, len: c - start })
    start = c
    cur = k
  }
  return out
}
