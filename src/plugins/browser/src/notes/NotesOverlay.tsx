// Pin overlay rendered OVER the iframe (never injected into the page — page CSS
// can't break pins, pins can't break the page). Pointer-transparent except over
// pins/popovers; fully pointer-active in placing mode to capture the drop click.
import { useState } from 'react'
import type { BrowserNote } from '../../../../domain/types'

export interface NotesOverlayProps {
  /** Notes for the CURRENT page only (caller pre-filters by URL). */
  notes: BrowserNote[]
  /** Iframe document scroll offset — pins are stored in document coords. */
  scroll: { x: number; y: number }
  placing: boolean
  accent: string
  onPlace: (pt: { viewportX: number; viewportY: number }) => void
  onCommentChange: (id: string, comment: string) => void
  onDelete: (id: string) => void
  openNoteId: string | null
  onToggleOpen: (id: string | null) => void
}

export function NotesOverlay(p: NotesOverlayProps) {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: p.placing ? 'auto' : 'none' }}>
      {p.placing && (
        <div
          data-testid="bw-notes-placement-layer"
          className="absolute inset-0 cursor-crosshair"
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            p.onPlace({ viewportX: e.clientX - rect.left, viewportY: e.clientY - rect.top })
          }}
        />
      )}
      {p.notes.map((n, i) => (
        <Pin
          key={n.id}
          note={n}
          index={i + 1}
          left={n.x - p.scroll.x}
          top={n.y - p.scroll.y}
          accent={p.accent}
          open={p.openNoteId === n.id}
          onToggleOpen={() => p.onToggleOpen(p.openNoteId === n.id ? null : n.id)}
          onCommentChange={c => p.onCommentChange(n.id, c)}
          onDelete={() => p.onDelete(n.id)}
        />
      ))}
    </div>
  )
}

function Pin(p: {
  note: BrowserNote; index: number; left: number; top: number; accent: string
  open: boolean; onToggleOpen: () => void; onCommentChange: (c: string) => void; onDelete: () => void
}) {
  const sent = !!p.note.sentAt
  const [draft, setDraft] = useState(p.note.comment)
  return (
    <div className="absolute" style={{ left: p.left, top: p.top, pointerEvents: 'auto' }}>
      <button
        data-testid={`bw-note-pin-${p.note.id}`}
        data-sent={sent ? 'true' : 'false'}
        onClick={p.onToggleOpen}
        className={`-translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full border text-[10px] font-mono font-bold flex items-center justify-center shadow transition-transform hover:scale-110 ${
          sent ? 'bg-slate-700 border-slate-500 text-slate-400' : 'text-white border-white/40'
        }`}
        style={sent ? undefined : { background: p.accent }}
        title={sent ? `Sent — ${p.note.comment}` : p.note.comment || 'Click to edit'}
      >
        {sent ? '✓' : p.index}
      </button>
      {p.open && (
        <div
          data-testid={`bw-note-popover-${p.note.id}`}
          className="absolute left-3 top-3 z-10 w-52 rounded border border-white/15 bg-surface-panel shadow-xl p-1.5 flex flex-col gap-1"
        >
          {sent ? (
            <div className="text-2xs text-slate-400 whitespace-pre-wrap">
              <span className="text-slate-600">✓ sent · </span>{p.note.comment || '(no comment)'}
            </div>
          ) : (
            <>
              <textarea
                data-testid={`bw-note-comment-${p.note.id}`}
                value={draft}
                autoFocus
                rows={3}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => p.onCommentChange(draft)}
                onKeyDown={e => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur() }}
                placeholder="What about this spot?"
                className="w-full bg-surface-base text-2xs text-slate-200 rounded border border-white/10 outline-none focus:border-primary/50 p-1 resize-none"
              />
              <button
                data-testid={`bw-note-delete-${p.note.id}`}
                onClick={p.onDelete}
                className="self-end text-slate-600 hover:text-red-400"
                title="Delete note"
              >
                <span className="material-symbols-outlined text-sm">delete</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
