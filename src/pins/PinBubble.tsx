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
import { threadMessages, type Reply } from '../domain/pinSet'

interface PinBubbleProps {
  id: string; comment: string; sent: boolean; canSubmit: boolean
  replies: Reply[]
  resolved: boolean
  /** The open marker's wrapper/button element — anchors the bubble's screen position. */
  anchorEl: HTMLElement | null
  onCommentChange: (c: string) => void
  onDelete: () => void
  onSubmit: (comment: string) => void
  onReply: (text: string) => void
  onResolve: () => void
  onReopen: () => void
}

// Bubble dimensions used only for viewport-edge flipping (w-52 = 208px; height varies
// ~120-140px). The popup itself sizes to content; these are conservative estimates.
// Exported so PinBubble.test can assert the canvas-clamp math against the source of
// truth instead of duplicating magic numbers.
export const BUBBLE_W = 208
export const BUBBLE_H = 140
export const GAP = 6
export const MARGIN = 8

type Bounds = { left: number; top: number; right: number; bottom: number }

// The visible canvas region — the bubble clamps/clips to this rather than the full
// window. The marker lives inside the canvas's `overflow-clip` container, but the
// bubble is portaled to <body> (position:fixed) so that container can't clip it.
// Without this the bubble keeps rendering at the marker's screen position even after
// the canvas pans the marker off-screen (e.g. clicking inbox sessions → centerOn),
// spilling the note over the sidebar/inbox. Falls back to the viewport when no canvas
// ancestor exists (e.g. unit tests, other mounts).
function canvasBounds(anchorEl: HTMLElement): Bounds {
  const canvas = anchorEl.closest('[data-testid="infinite-canvas"]')
  if (canvas) {
    const r = canvas.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

function placement(anchorEl: HTMLElement, bounds: Bounds): { left: number; top: number } {
  const rect = anchorEl.getBoundingClientRect()
  // Default: just right of + level with the marker (mirrors the old left-3/top-3 offset).
  let left = rect.right + GAP
  let top = rect.top
  // Flip to the LEFT of the marker if the bubble would spill off the canvas's right edge.
  if (left + BUBBLE_W > bounds.right - MARGIN) {
    left = rect.left - BUBBLE_W - GAP
  }
  // Shift up if it would spill off the canvas's bottom edge.
  if (top + BUBBLE_H > bounds.bottom - MARGIN) {
    top = bounds.bottom - BUBBLE_H - MARGIN
  }
  // Never let the bubble cross the canvas's top/left edges onto the sidebar/chrome.
  return { left: Math.max(bounds.left + MARGIN, left), top: Math.max(bounds.top + MARGIN, top) }
}

export function PinBubble(p: PinBubbleProps) {
  const [draft, setDraft] = useState(p.comment)
  const [reply, setReply] = useState('')
  if (!p.anchorEl) return null
  const bounds = canvasBounds(p.anchorEl)
  // Mirror the marker's clipping: when the canvas pans the anchor off its viewport,
  // hide the note too instead of letting it float over the sidebar/inbox.
  const rect = p.anchorEl.getBoundingClientRect()
  const cx = (rect.left + rect.right) / 2
  const cy = (rect.top + rect.bottom) / 2
  if (cx < bounds.left || cx > bounds.right || cy < bounds.top || cy > bounds.bottom) return null
  const { left, top } = placement(p.anchorEl, bounds)
  // PinBubble renders author/text/key only — it does not read createdAt — so we pass
  // just the fields threadMessages needs for display (the bubble has no full Pin here).
  const msgs = threadMessages({ id: p.id, comment: p.comment, replies: p.replies } as Parameters<typeof threadMessages>[0])
  const lastMsg = msgs[msgs.length - 1]
  // Shimmer = the note is sent, unresolved, and the last message is the user's
  // (either the original comment with no agent reply yet, or a user follow-up
  // awaiting a reply). Intentionally true right after send until the agent replies.
  const awaiting = p.sent && !p.resolved && lastMsg?.author === 'user'

  return createPortal(
    <div
      data-testid={`pin-bubble-${p.id}`}
      style={{ position: 'fixed', left, top, zIndex: 60 }}
      className="w-52 rounded border border-white/15 bg-surface-panel shadow-xl p-1.5 flex flex-col gap-1"
    >
      {!p.sent ? (
        <>
          <textarea
            data-testid={`pin-comment-${p.id}`}
            value={draft} autoFocus rows={3}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => p.onCommentChange(draft)}
            onKeyDown={e => {
              if (e.key === 'Escape') { (e.target as HTMLTextAreaElement).blur(); return }
              // Ctrl/Cmd+Enter sends, matching the prompt composer. Plain Enter is
              // left free for newlines (notes can be multi-line). Gate on canSubmit
              // so this mirrors the Send button's disabled state exactly.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && p.canSubmit) {
                e.preventDefault()
                p.onCommentChange(draft)
                p.onSubmit(draft)
              }
            }}
            placeholder="What about this spot?"
            className="w-full bg-surface-base text-2xs text-slate-200 rounded border border-white/10 outline-none focus:border-primary/50 p-1 resize-none"
          />
          <div className="flex items-center justify-between">
            <button data-testid={`pin-delete-${p.id}`} onClick={p.onDelete}
              className="text-slate-600 hover:text-red-400" title="Delete pin">
              <span className="material-symbols-outlined text-sm">delete</span>
            </button>
            <button data-testid={`pin-submit-${p.id}`} disabled={!p.canSubmit}
              onClick={() => { p.onCommentChange(draft); p.onSubmit(draft) }}
              className="text-2xs px-1.5 py-0.5 rounded bg-primary/80 text-white flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              title={p.canSubmit ? 'Send to the agent' : 'Snap into a run to send'}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>send</span>
              Send
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-end gap-1 -mt-0.5">
            {p.resolved ? (
              <button data-testid={`pin-reopen-${p.id}`} onClick={p.onReopen}
                className="text-2xs text-slate-500 hover:text-primary" title="Reopen note">reopen</button>
            ) : (
              <button data-testid={`pin-resolve-${p.id}`} onClick={p.onResolve}
                className="text-slate-600 hover:text-emerald-400" title="Resolve note">
                <span className="material-symbols-outlined text-sm">check_circle</span>
              </button>
            )}
            <button data-testid={`pin-delete-${p.id}`} onClick={p.onDelete}
              className="text-slate-600 hover:text-red-400" title="Delete pin">
              <span className="material-symbols-outlined text-sm">delete</span>
            </button>
          </div>
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {msgs.map(m => (
              <div key={m.id} className="text-2xs">
                <div className={m.author === 'agent' ? 'text-primary/80' : 'text-slate-500'}>{m.author}</div>
                <div className="text-slate-200 whitespace-pre-wrap">{m.text || '(no comment)'}</div>
              </div>
            ))}
            {awaiting && (
              <div data-testid={`pin-awaiting-${p.id}`} className="text-2xs text-slate-500 animate-pulse">agent is replying…</div>
            )}
          </div>
          {!p.resolved && (
            <div className="flex items-center gap-1">
              <input
                data-testid={`pin-reply-input-${p.id}`}
                value={reply}
                onChange={e => setReply(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && reply.trim()) { p.onReply(reply.trim()); setReply('') } }}
                placeholder="Reply…"
                className="flex-1 bg-surface-base text-2xs text-slate-200 rounded border border-white/10 outline-none focus:border-primary/50 px-1 py-0.5"
              />
              <button data-testid={`pin-reply-send-${p.id}`} disabled={!reply.trim()}
                onClick={() => { if (reply.trim()) { p.onReply(reply.trim()); setReply('') } }}
                className="text-2xs px-1 py-0.5 rounded bg-primary/80 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                title="Send reply">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>send</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}
