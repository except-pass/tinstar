// The multi-question WORKBENCH (S4 U3) — a set of related open-points laid out one
// per COLUMN instead of one per row, so the user can see the whole series at once and
// answer each independently.
//
// What it is NOT: a new A2UI component, a new surface `kind`, or a new answer route.
// The interactive form state A2UI's controls read (`NoticeFormState`) is SURFACE-scoped
// — one `text`, one `submit()` per provider — so a single A2UI surface holding N
// question cards would bind every TextInput to the same draft and every Submit to the
// same call. Per-question independence therefore has to come from N independent points,
// which the Slate already has: each column is one existing open-point with its own
// `usePointAnswerForm`, its own `POST …/points/<id>/answer`, and its own answered-lock.
// The workbench is purely the LAYOUT over that, tied together by the file-owned `group`
// string.
//
// Layout (#126 guard): the band is its own `overflow-x-auto` scroller marked
// `data-scrollable`. The Slate's scroll body is `overflow-x-hidden`, so a horizontal
// scrollbar on a child of it would be unreachable — the band must own its scroll, and
// the canvas wheel handler must yield to it rather than panning the canvas. Columns are
// fixed-width and `shrink-0` with `[overflow-wrap:anywhere]`, so a long token wraps
// inside its column instead of forcing the panel itself to scroll sideways.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SlateSurface } from '../../types'
import { A2uiRenderer } from '../../a2ui/A2uiRenderer'
import { isAnswerable } from '../../a2ui/controls'
import { usePointAnswerForm } from './usePointAnswerForm'

/** A point whose thread already carries the user's answer. `waiting` means the last
 *  reply is the user's (the agent owes a response) — which is exactly what a submitted
 *  answer leaves behind; `resolved` is the explicit terminal. This is the DURABLE
 *  signal, so an answered column survives a reload. */
function durablyAnswered(s: SlateSurface): boolean {
  return s.status === 'waiting' || s.status === 'resolved'
}

/** One question. Owns its OWN answer form — nothing here is shared with a sibling
 *  column, which is the whole point: submitting this column can't touch that one. */
function WorkbenchColumn({ runId, surface, onAnswered }: {
  runId: string
  surface: SlateSurface
  /** Told whenever this column's optimistic answered-lock CHANGES, in either
   *  direction, so the band's progress count can follow it. Two-way on purpose: a
   *  failed delivery reverts the lock (`usePointAnswerForm` catch), and a one-way
   *  notification would leave the band claiming an answer the user still owes. It
   *  also self-heals a remount — a fresh column reports `false` on mount, which
   *  prunes a stale id left behind by a re-projection.
   *
   *  Still only a NOTIFICATION, not hoisted state: lifting the form itself would
   *  re-render every sibling on every keystroke, which is the coupling this layout
   *  exists to avoid. */
  onAnswered: (id: string, answered: boolean) => void
}) {
  const answer = usePointAnswerForm(runId, surface.id)
  // A body with no Choice/TextInput/Submit is prose: render it static (no form
  // provider) so nothing is ever half-wired into an un-submittable control.
  const interactive = isAnswerable(surface.body)

  useEffect(() => {
    onAnswered(surface.id, answer.answered)
  }, [answer.answered, surface.id, onAnswered])

  // VISUAL answered posture only. The control LOCK stays driven by `answer.form.answered`
  // (the local optimistic flag) — second-guessing the reconciled status mid-flight is
  // the race the row model deliberately avoids, and a thread reply that isn't an answer
  // shouldn't take the controls away.
  const answered = answer.answered || durablyAnswered(surface)
  // A point taken off the table reads as off the table — the same 50% dim the row
  // wears for `dismissed` (design language: "Dismissed = off-track, dimmed row"), so
  // the column can't invite an answer to a question that's already closed. Kept
  // purely visual: the controls stay exactly as live as they are on the row, because
  // the row and the column deliberately share one answer path.
  const dismissed = surface.status === 'dismissed'

  return (
    <div
      data-testid={`workbench-column-${surface.id}`}
      data-answered={answered ? 'true' : undefined}
      data-status={surface.status}
      // The same hairline card shell every Slate row wears (P3: sharp radius, hairline
      // border, one lightness step) — an answered column swaps the hairline for the
      // resolved hue rather than dimming, so it reads as DONE, not as disabled.
      className={`w-[240px] shrink-0 rounded border bg-surface-hover p-2.5 [overflow-wrap:anywhere] ${
        answered ? 'border-hue-resolved/30' : 'border-hairline'
      } ${dismissed ? 'opacity-50' : ''}`}
    >
      {/* The question itself. Display face for a surface headline; it is the only thing
          distinguishing one column from the next, so it wraps rather than truncating. */}
      <div className="font-display text-[13px] font-semibold leading-snug text-ink-high">
        {surface.headline ?? '(untitled question)'}
      </div>
      {surface.body && (
        <div className="mt-2 text-[13px] text-ink-mid">
          <A2uiRenderer content={surface.body} form={interactive ? answer.form : undefined} />
        </div>
      )}
      {/* A prose-only column has nothing to submit — say so quietly, in the read-only
          register (55%-weight control ink), rather than leaving the reader hunting for
          a control that was never authored. */}
      {!interactive && (
        <div
          data-testid={`workbench-readonly-${surface.id}`}
          className="mt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-ctrl"
        >
          read-only
        </div>
      )}
      {answer.error && (
        <div data-testid={`workbench-error-${surface.id}`} className="mt-1 text-[11px] text-hue-error">
          {answer.error}
        </div>
      )}
    </div>
  )
}

interface Props {
  runId: string
  /** The file-owned set id these points share. Also the band's test id suffix. */
  group: string
  /** The points in this set, already ordered by the caller. */
  points: SlateSurface[]
}

/** A grouped question set, rendered as a horizontal band of independent columns. */
export function WorkbenchSurface({ runId, group, points }: Props) {
  // Which columns have optimistically locked. Held here ONLY to move the progress
  // count; the answer state itself still lives in each column's own hook. Two-way —
  // a delivery that fails un-locks its column, and the count MUST follow it back
  // down, or the one number the user scans to decide whether the series is done
  // lies in exactly the case where it isn't.
  const [optimistic, setOptimistic] = useState<ReadonlySet<string>>(() => new Set())
  const markAnswered = useCallback((id: string, answered: boolean) => {
    setOptimistic((prev) => {
      if (prev.has(id) === answered) return prev
      const next = new Set(prev)
      if (answered) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  // The questions still ON the table. A `dismissed` point is off it — it can never
  // become `waiting`/`resolved`, so leaving it in the DENOMINATOR would pin the count
  // below its ceiling forever ("1 of 2 answered" on a series with nothing left to
  // answer), which is the same lie as a count that can't come back down. It is
  // dropped from BOTH sides rather than counted as answered, because "answered" is
  // not what happened to it. Reachable: a point can be dismissed as a row and then
  // grouped by a later file write, and a column carries no dismiss chrome to undo it.
  const live = useMemo(() => points.filter((s) => s.status !== 'dismissed'), [points])

  // Counted over `live`, never over the optimistic set itself, so an id that has left
  // the group (re-projection, group cleared, dismissal) can't inflate the total.
  const answeredCount = useMemo(
    () => live.filter((s) => durablyAnswered(s) || optimistic.has(s.id)).length,
    [live, optimistic],
  )

  if (points.length === 0) return null

  return (
    <div data-testid={`workbench-${group}`} data-group={group} className="space-y-1.5">
      {/* Band label: mono caps meta, with the progress count on the right. The label
          counts every COLUMN (what's on screen); the progress counts only the live
          ones (what's still being asked). They differ exactly when a question has
          been dismissed — which is what the dimmed column is showing. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-low">
          Questions · {points.length}
        </span>
        {live.length > 0 && (
          <span
            data-testid={`workbench-progress-${group}`}
            title={
              live.length === points.length
                ? undefined
                : `${points.length - live.length} dismissed — not counted`
            }
            className="shrink-0 font-mono text-[10px] text-ink-ctrl"
          >
            {answeredCount} of {live.length} answered
          </span>
        )}
      </div>
      {/* The scroller. `data-scrollable` makes the canvas wheel handler yield the wheel
          to this band; its OWN overflow-x-auto keeps the horizontal scroll off the panel
          body (which is overflow-x-hidden, so a scrollbar there would be unreachable). */}
      <div
        data-scrollable
        data-testid={`workbench-scroller-${group}`}
        className="flex flex-row items-start gap-2 overflow-x-auto scrollbar-thin pb-1"
      >
        {points.map((surface) => (
          <WorkbenchColumn
            key={surface.id}
            runId={runId}
            surface={surface}
            onAnswered={markAnswered}
          />
        ))}
      </div>
    </div>
  )
}

/** The set id a surface belongs to, or '' for an ungrouped point. */
function groupKey(s: SlateSurface): string {
  return typeof s.group === 'string' ? s.group.trim() : ''
}

const EMPTY_EXCLUDED: ReadonlySet<string> = new Set()

/**
 * Split points into workbench SETS and ordinary rows.
 *
 * A set needs at least TWO members: a one-column band is just a row with extra chrome,
 * and the vertical row carries strictly more (thread, soft resolve, reorder, hide), so
 * a lone grouped point falls back to a row — IN ITS ORIGINAL POSITION, which is why the
 * counts are taken in a first pass rather than appending stragglers at the end.
 *
 * `excluded` names points that must NEVER be swallowed into a band regardless of their
 * `group` — in practice the HIDDEN ones. A column renders none of the row's hide chrome,
 * so a hidden point promoted to a column would lose its only unhide affordance and be
 * stranded: the panel's "N hidden · show" toggle would reveal something it could not
 * restore. Excluding them also means the composition of a band no longer changes when
 * the reveal toggle flips. An excluded point doesn't count toward its group's size, so
 * a two-member set with one hidden member correctly degrades to a single row.
 *
 * Bands are emitted BEFORE the rows (a question series is the thing the user is being
 * asked to work through, so it sits above the standing list rather than buried in it);
 * `earliest` therefore only orders bands relative to EACH OTHER, it does not interleave
 * them into the row list.
 *
 * Exported so tests — and any future caller that needs to know which rows the workbench
 * swallowed — use the SAME rule the render does instead of re-deriving it.
 */
export function partitionWorkbenches(
  points: SlateSurface[],
  excluded: ReadonlySet<string> = EMPTY_EXCLUDED,
): {
  groups: Array<{ group: string; points: SlateSurface[] }>
  ungrouped: SlateSurface[]
} {
  const groupable = (s: SlateSurface) => groupKey(s) !== '' && !excluded.has(s.id)

  const counts = new Map<string, number>()
  for (const s of points) {
    if (groupable(s)) counts.set(groupKey(s), (counts.get(groupKey(s)) ?? 0) + 1)
  }

  const byGroup = new Map<string, SlateSurface[]>()
  const ungrouped: SlateSurface[] = []
  for (const s of points) {
    const g = groupKey(s)
    if (!groupable(s) || (counts.get(g) ?? 0) < 2) {
      ungrouped.push(s)
      continue
    }
    const members = byGroup.get(g)
    if (members) members.push(s)
    else byGroup.set(g, [s])
  }

  const groups = [...byGroup].map(([group, members]) => ({ group, points: members }))
  const earliest = (g: { points: SlateSurface[] }) => Math.min(...g.points.map((s) => s.createdAt))
  groups.sort((a, b) => earliest(a) - earliest(b) || (a.group < b.group ? -1 : 1))
  return { groups, ungrouped }
}
