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
export function compositeColumns(
  bands: Band[],
  t0: number,
  t1: number,
  px: number,
): (BandKind | null)[] {
  const span = Math.max(t1 - t0, 1e-9)
  const nk = BAND_KINDS.length
  const acc = new Float64Array(px * nk)

  for (const b of bands) {
    const x = ((b.start - t0) / span) * px
    const x2 = ((b.end - t0) / span) * px
    let a = Math.floor(x)
    let z = Math.ceil(x2)
    if (z <= a) z = a + 1
    if (a < 0) a = 0
    if (z > px) z = px
    const ki = BAND_KINDS.indexOf(b.kind)
    if (ki < 0) continue
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
