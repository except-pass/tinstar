// The pin message bubble — popover for editing/sending a pin's comment. Ported from
// the browser NotesOverlay popover, plus a Send button (host wires submit). Holds a
// local draft so typing is snappy; commits to the host on blur/submit.
//
// Rendered via a PORTAL to document.body and positioned `fixed` at the open marker's
// screen location. This lets the bubble overshoot the widget edge (the pin LAYER is
// `overflow-hidden` to clip markers, which would otherwise truncate the bubble), and
// dodges the canvas's CSS `transform` re-rooting `position:fixed` (a transformed
// ancestor becomes the containing block — see memory feedback_fixed_menu_canvas_transform).
import { useState } from 'react'
import { createPortal } from 'react-dom'

interface PinBubbleProps {
  id: string; comment: string; sent: boolean; canSubmit: boolean
  /** The open marker's wrapper/button element — anchors the bubble's screen position. */
  anchorEl: HTMLElement | null
  onCommentChange: (c: string) => void; onDelete: () => void; onSubmit: () => void
}

// Bubble dimensions used only for viewport-edge flipping (w-52 = 208px; height varies
// ~120-140px). The popup itself sizes to content; these are conservative estimates.
const BUBBLE_W = 208
const BUBBLE_H = 140
const GAP = 6
const MARGIN = 8

function placement(anchorEl: HTMLElement): { left: number; top: number } {
  const rect = anchorEl.getBoundingClientRect()
  // Default: just right of + level with the marker (mirrors the old left-3/top-3 offset).
  let left = rect.right + GAP
  let top = rect.top
  // Flip to the LEFT of the marker if the bubble would spill off the right edge.
  if (left + BUBBLE_W > window.innerWidth - MARGIN) {
    left = rect.left - BUBBLE_W - GAP
  }
  // Shift up if it would spill off the bottom edge.
  if (top + BUBBLE_H > window.innerHeight - MARGIN) {
    top = window.innerHeight - BUBBLE_H - MARGIN
  }
  return { left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) }
}

export function PinBubble(p: PinBubbleProps) {
  const [draft, setDraft] = useState(p.comment)
  if (!p.anchorEl) return null
  const { left, top } = placement(p.anchorEl)
  return createPortal(
    <div
      data-testid={`pin-bubble-${p.id}`}
      style={{ position: 'fixed', left, top, zIndex: 60 }}
      className="w-52 rounded border border-white/15 bg-surface-panel shadow-xl p-1.5 flex flex-col gap-1"
    >
      {p.sent ? (
        <div className="text-2xs text-slate-400 whitespace-pre-wrap">
          <span className="text-slate-600">✓ sent · </span>{p.comment || '(no comment)'}
        </div>
      ) : (
        <>
          <textarea
            data-testid={`pin-comment-${p.id}`}
            value={draft} autoFocus rows={3}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => p.onCommentChange(draft)}
            onKeyDown={e => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur() }}
            placeholder="What about this spot?"
            className="w-full bg-surface-base text-2xs text-slate-200 rounded border border-white/10 outline-none focus:border-primary/50 p-1 resize-none"
          />
          <div className="flex items-center justify-between">
            <button data-testid={`pin-delete-${p.id}`} onClick={p.onDelete}
              className="text-slate-600 hover:text-red-400" title="Delete pin">
              <span className="material-symbols-outlined text-sm">delete</span>
            </button>
            <button data-testid={`pin-submit-${p.id}`} disabled={!p.canSubmit}
              onClick={() => { p.onCommentChange(draft); p.onSubmit() }}
              className="text-2xs px-1.5 py-0.5 rounded bg-primary/80 text-white flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              title={p.canSubmit ? 'Send to the agent' : 'Snap into a run to send'}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>send</span>
              Send
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
