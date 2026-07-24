// "Clean the Slate" (🧹) — the Slate-level wipe, plus its confirmation.
//
// Distinct from the per-surface ✕ hide next to it, and the distinction is the
// whole reason this needs a confirmation while hide doesn't: hide is a
// per-browser VIEW preference that a re-projection can undo, this DELETES the
// agent's `.tinstar/slate/*.json` files and the user's own points. There is no
// undo, so the dialog states the real counts before it destroys anything.
//
// The Objective is deliberately untouched (see `clearSlateForRun`) and the dialog
// says so — a user who has pinned a goal should not have to guess whether the
// broom takes it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../apiClient'

interface Props {
  runId: string
  /** How many authored surfaces the wipe will take. Drives the button's presence
   *  (nothing to clean → no button) and the dialog's copy. Counts SURFACES, not
   *  the filtered/visible subset — see the note on `onClean`. */
  surfaceCount: number
  /** True when the run has a pinned Objective, so the dialog can promise it
   *  survives rather than claiming so unconditionally. */
  hasObjective: boolean
  /** Called after a successful clean, so the panel can drop view state (hidden /
   *  minimized ids) that now points at surfaces which no longer exist. */
  onCleaned: () => void
}

/** The confirmation dialog. Portaled to `document.body` and Escape-on-capture for
 *  the same two canvas reasons as the diagram lightbox:
 *
 *   · the Slate lives inside the infinite canvas, which puts a CSS `transform` on
 *     widget containers, and a transform re-roots `position: fixed` onto that
 *     ancestor instead of the viewport — an inline overlay lands displaced and
 *     scaled, far from the cursor;
 *   · InfiniteCanvas keeps a BUBBLE-phase window Escape handler that cancels
 *     drags, deselects everything and refocuses the canvas. It registered first,
 *     so a second bubble-phase listener can't stopPropagation ahead of it.
 *     Listening on capture is what actually gets in front, so cancelling this
 *     dialog doesn't also blow away the user's canvas selection. */
function CleanConfirm({ surfaceCount, hasObjective, busy, onConfirm, onCancel }: {
  surfaceCount: number
  hasObjective: boolean
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  // Focus the SAFE choice on open. A destructive dialog should never open with
  // the destructive button under a stray Enter.
  useEffect(() => { cancelRef.current?.focus() }, [])

  const noun = surfaceCount === 1 ? 'surface' : 'surfaces'

  return createPortal(
    <div
      data-testid="slate-clean-confirm"
      role="dialog"
      aria-modal="true"
      aria-label="Clean the Slate"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-8"
      onClick={onCancel}
    >
      <div
        data-scrollable
        className="w-[22rem] max-w-full rounded border border-hairline bg-surface-raised p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display text-sm font-semibold text-ink-high">Clean the Slate?</div>
        <div className="font-sans text-[13px] leading-[1.5] text-ink-mid">
          This deletes {surfaceCount} {noun} — including the agent&apos;s files in{' '}
          <span className="font-mono text-2xs text-ink-high">.tinstar/slate/</span> — and can&apos;t be
          undone.
          {hasObjective && ' Your Objective stays.'}
        </div>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            data-testid="slate-clean-cancel"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-hairline px-2 py-1 font-mono text-2xs text-ink-ctrl hover:text-ink-high disabled:opacity-70"
          >
            Cancel
          </button>
          <button
            data-testid="slate-clean-go"
            onClick={onConfirm}
            disabled={busy}
            className="rounded border border-hue-error/60 px-2 py-1 font-mono text-2xs text-hue-error hover:bg-hue-error/10 disabled:opacity-70"
          >
            {busy ? 'Cleaning…' : 'Clean'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function SlateCleanButton({ runId, surfaceCount, hasObjective, onCleaned }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const cancel = useCallback(() => { if (!busy) setOpen(false) }, [busy])

  const clean = useCallback(async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/runs/${encodeURIComponent(runId)}/slate`, { method: 'DELETE' })
      // Surfaces disappear via the store's own projection/SSE, not by us mutating
      // a local list — one write path, same as every other Slate mutation.
      onCleaned()
      setOpen(false)
    } catch {
      // Best-effort, like the refresh fan-out: leave the dialog open so the user
      // can retry rather than silently swallowing the failure and closing.
    } finally {
      setBusy(false)
    }
  }, [runId, onCleaned])

  // Nothing to clean → no button. A destructive control that does nothing is a
  // trap: the user clicks, confirms, and learns nothing about why it was a no-op.
  if (surfaceCount === 0) return null

  return (
    <>
      <button
        data-testid="slate-clean"
        onClick={() => setOpen(true)}
        // ALWAYS every surface, never the filtered subset — unlike refresh-all,
        // which does fan out over matches. A destructive action must not silently
        // depend on a transient view filter, so the count here is the true total.
        title={`Clean the Slate — delete all ${surfaceCount} surface${surfaceCount === 1 ? '' : 's'}`}
        // Quiet control ink, never cyan: the design language reserves cyan for the
        // live edge, and this is destructive maintenance, not liveness.
        className="text-ink-ctrl hover:text-hue-error leading-none transition-colors"
      >
        🧹
      </button>
      {open && (
        <CleanConfirm
          surfaceCount={surfaceCount}
          hasObjective={hasObjective}
          busy={busy}
          onConfirm={() => void clean()}
          onCancel={cancel}
        />
      )}
    </>
  )
}
