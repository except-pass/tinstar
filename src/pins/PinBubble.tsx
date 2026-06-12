// The pin message bubble — popover for editing/sending a pin's comment. Ported from
// the browser NotesOverlay popover, plus a Send button (host wires submit). Holds a
// local draft so typing is snappy; commits to the host on blur/submit.
import { useState } from 'react'

interface PinBubbleProps {
  id: string; comment: string; sent: boolean; canSubmit: boolean
  onCommentChange: (c: string) => void; onDelete: () => void; onSubmit: () => void
}

export function PinBubble(p: PinBubbleProps) {
  const [draft, setDraft] = useState(p.comment)
  return (
    <div
      data-testid={`pin-bubble-${p.id}`}
      className="absolute left-3 top-3 z-10 w-52 rounded border border-white/15 bg-surface-panel shadow-xl p-1.5 flex flex-col gap-1"
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
              className="text-2xs px-1.5 py-0.5 rounded bg-primary/80 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              title={p.canSubmit ? 'Send to the agent' : 'Snap into a run to send'}>
              Send
            </button>
          </div>
        </>
      )}
    </div>
  )
}
