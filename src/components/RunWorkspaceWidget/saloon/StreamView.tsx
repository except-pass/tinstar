import { useMemo, useState } from 'react'
import type { SaloonEvent } from './useSaloonStream'
import { classifySubject, type SubjectRole } from './subjectRole'
import { useTopicMetadata } from './useTopicMetadata'
import { useBackendState } from '../../../hooks/useBackendState'
import { MessageDetailModal } from './MessageDetailModal'

interface Props {
  sessionName: string
  events: SaloonEvent[]
  mutedSet: Set<string>
  onUnmuteAll: () => void
}

const ROLE_BORDER: Record<SubjectRole, string> = {
  broadcast: 'border-l-cyan-400/70',
  dm: 'border-l-amber-400/70',
  breakout: 'border-l-violet-400/70',
}
const ROLE_TEXT: Record<SubjectRole, string> = {
  broadcast: 'text-cyan-400',
  dm: 'text-amber-400',
  breakout: 'text-violet-400',
}

export function StreamView({ sessionName, events, mutedSet, onUnmuteAll }: Props) {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const { topicMetadata } = useBackendState()
  const [detailIndex, setDetailIndex] = useState<number | null>(null)

  const nameByEvent = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const m of topicMetadata) map.set(m.subject, m.name)
    return map
  }, [topicMetadata])

  const visible = useMemo(() => {
    return events.filter(e => {
      if (mutedSet.has(e.subject)) return false
      if (!needle) return true
      const subjectLower = e.subject.toLowerCase()
      const dataLower = e.data.toLowerCase()
      const nameLower = (nameByEvent.get(e.subject) ?? '').toLowerCase()
      return subjectLower.includes(needle) || dataLower.includes(needle) || nameLower.includes(needle)
    })
  }, [events, mutedSet, needle, nameByEvent])

  // If filter changes after a modal was opened, the index may now point past
  // the end of `visible`. Clamp/close defensively.
  const clampedDetailIndex = detailIndex !== null && detailIndex < visible.length ? detailIndex : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-white/5 bg-surface-panel">
        <input
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 bg-transparent text-2xs font-mono text-slate-300 outline-none placeholder-slate-600 min-w-0"
        />
        {mutedSet.size > 0 && (
          <button
            data-testid="saloon-hidden-pill"
            onClick={onUnmuteAll}
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-400"
          >
            {mutedSet.size} hidden
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {visible.map((e, i) => (
          <StreamRow
            key={i}
            event={e}
            sessionName={sessionName}
            needle={needle}
            onClick={() => setDetailIndex(i)}
          />
        ))}
      </div>
      {clampedDetailIndex !== null && (
        <MessageDetailModal
          events={visible}
          index={clampedDetailIndex}
          sessionName={sessionName}
          onClose={() => setDetailIndex(null)}
          onNavigate={setDetailIndex}
        />
      )}
    </div>
  )
}

function StreamRow({ event, sessionName, needle, onClick }: { event: SaloonEvent; sessionName: string; needle: string; onClick: () => void }) {
  const role = classifySubject(event.subject, sessionName)
  const md = useTopicMetadata(event.subject)
  const display = md?.name ?? shortSubject(event.subject)
  return (
    <div
      data-testid="saloon-msg"
      onClick={onClick}
      className={`px-2 py-1 border-b border-white/5 border-l-2 ${ROLE_BORDER[role]} text-2xs font-mono cursor-pointer hover:bg-white/5`}
      title="Click to expand"
    >
      <div className="flex gap-1 items-baseline">
        <span className="text-[9px] text-slate-600 shrink-0">{formatTime(event.timestamp)}</span>
        <span className={`flex-1 min-w-0 truncate ${ROLE_TEXT[role]}`} title={event.subject}>
          {highlight(display, needle)}
        </span>
      </div>
      <div className="text-slate-300 line-clamp-3 whitespace-pre-wrap break-words" title={event.data}>
        {highlight(event.data, needle)}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false }) }
  catch { return iso }
}

function shortSubject(s: string): string {
  const parts = s.split('.')
  if (parts.length <= 3) return s
  return '…' + parts.slice(-2).join('.')
}

function highlight(text: string, needle: string): React.ReactNode {
  if (!needle) return text
  const lower = text.toLowerCase()
  const out: React.ReactNode[] = []
  let i = 0
  while (i < text.length) {
    const hit = lower.indexOf(needle, i)
    if (hit === -1) { out.push(text.slice(i)); break }
    if (hit > i) out.push(text.slice(i, hit))
    out.push(<mark key={hit} className="bg-amber-400/30 text-amber-100">{text.slice(hit, hit + needle.length)}</mark>)
    i = hit + needle.length
  }
  return out
}
