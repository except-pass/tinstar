import { useEffect } from 'react'
import type { SaloonEvent } from './useSaloonStream'
import { classifySubject, type SubjectRole } from './subjectRole'
import { useTopicMetadata } from './useTopicMetadata'

interface Props {
  events: SaloonEvent[]
  index: number
  sessionName: string
  onClose: () => void
  onNavigate: (next: number) => void
}

const ROLE_TEXT: Record<SubjectRole, string> = {
  broadcast: 'text-cyan-400',
  dm: 'text-amber-400',
  breakout: 'text-violet-400',
}

export function MessageDetailModal({ events, index, sessionName, onClose, onNavigate }: Props) {
  const event = events[index]

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onNavigate(index - 1) }
      else if (e.key === 'ArrowRight' && index < events.length - 1) { e.preventDefault(); onNavigate(index + 1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [events.length, index, onClose, onNavigate])

  if (!event) return null
  const role = classifySubject(event.subject, sessionName)
  return (
    <div
      data-testid="saloon-msg-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col font-mono"
        onClick={e => e.stopPropagation()}
      >
        <ModalHeader event={event} role={role} index={index} total={events.length} onClose={onClose} />
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-sm text-slate-200 whitespace-pre-wrap break-words">
          {event.data}
        </div>
        <ModalFooter
          index={index}
          total={events.length}
          onPrev={() => index > 0 && onNavigate(index - 1)}
          onNext={() => index < events.length - 1 && onNavigate(index + 1)}
        />
      </div>
    </div>
  )
}

function ModalHeader({ event, role, index, total, onClose }: { event: SaloonEvent; role: SubjectRole; index: number; total: number; onClose: () => void }) {
  const md = useTopicMetadata(event.subject)
  const display = md?.name ?? event.subject
  const ts = (() => { try { return new Date(event.timestamp).toLocaleString() } catch { return event.timestamp } })()
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10">
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold truncate ${ROLE_TEXT[role]}`} title={event.subject}>{display}</div>
        <div className="text-2xs text-slate-500 truncate">{event.subject} · {ts}</div>
      </div>
      <span className="text-2xs text-slate-500 shrink-0">{index + 1} / {total}</span>
      <button onClick={onClose} className="text-slate-400 hover:text-slate-200" title="Close (Esc)">
        <span className="material-symbols-outlined text-lg">close</span>
      </button>
    </div>
  )
}

function ModalFooter({ index, total, onPrev, onNext }: { index: number; total: number; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-white/10 text-2xs text-slate-500">
      <button
        onClick={onPrev}
        disabled={index === 0}
        className="px-2 py-1 rounded border border-slate-600 hover:text-slate-300 hover:border-slate-400 disabled:opacity-30 disabled:cursor-not-allowed"
        title="Previous (←)"
      >← Prev</button>
      <span className="flex-1 text-center">use ← / → keys to page through</span>
      <button
        onClick={onNext}
        disabled={index === total - 1}
        className="px-2 py-1 rounded border border-slate-600 hover:text-slate-300 hover:border-slate-400 disabled:opacity-30 disabled:cursor-not-allowed"
        title="Next (→)"
      >Next →</button>
    </div>
  )
}
