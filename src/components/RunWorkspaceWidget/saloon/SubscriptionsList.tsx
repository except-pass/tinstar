import { useState } from 'react'
import { classifySubject, type SubjectRole } from './subjectRole'
import { useTopicMetadata } from './useTopicMetadata'
import { apiFetch } from '../../../apiClient'

interface Props {
  sessionName: string
  subscriptions: string[]
  mutedSet: Set<string>
  onToggleMute: (subject: string) => void
}

const ROLE_COLOR: Record<SubjectRole, string> = {
  broadcast: 'text-cyan-400 border-cyan-400/40',
  dm: 'text-amber-400 border-amber-400/40',
  breakout: 'text-violet-400 border-violet-400/40',
}

export function SubscriptionsList({ sessionName, subscriptions, mutedSet, onToggleMute }: Props) {
  if (subscriptions.length === 0) {
    return (
      <div className="px-2 py-3 text-2xs font-mono text-slate-700 text-center">
        No subscriptions yet
      </div>
    )
  }
  return (
    <div>
      {subscriptions.map(subject => (
        <SubscriptionRow
          key={subject}
          subject={subject}
          sessionName={sessionName}
          muted={mutedSet.has(subject)}
          onToggleMute={onToggleMute}
        />
      ))}
    </div>
  )
}

interface RowProps {
  subject: string
  sessionName: string
  muted: boolean
  onToggleMute: (s: string) => void
}

function SubscriptionRow({ subject, sessionName, muted, onToggleMute }: RowProps) {
  const role = classifySubject(subject, sessionName)
  const md = useTopicMetadata(subject)
  const display = md?.name ?? shortSubject(subject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(display)

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(md?.name ?? '')
    setEditing(true)
  }
  const submit = async () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (!trimmed || trimmed === md?.name) return
    try {
      await apiFetch(`/api/topics/${encodeURIComponent(subject)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
    } catch { /* SSE will reconcile */ }
  }
  const cancel = () => { setEditing(false); setDraft(md?.name ?? '') }

  const tooltip = [
    `Subject: ${subject}`,
    `Role: ${role}`,
    md?.description ? `${md.description}` : null,
    md?.createdAt ? `Created: ${md.createdAt}` : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      data-testid="saloon-topic"
      data-role={role}
      data-muted={muted ? 'true' : 'false'}
      title={tooltip}
      onClick={() => !editing && onToggleMute(subject)}
      className={`group flex items-center gap-1 px-2 py-1 text-2xs font-mono truncate border-l-2 cursor-pointer hover:bg-primary/5 transition-opacity ${ROLE_COLOR[role]} ${muted ? 'opacity-40' : ''}`}
    >
      {editing ? (
        <input
          data-testid="saloon-rename-input"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') cancel()
          }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-surface-base text-slate-200 outline-none px-1 rounded"
        />
      ) : (
        <span className="flex-1 truncate">{display}</span>
      )}
      {!editing && (
        <button
          data-testid="saloon-rename"
          onClick={startRename}
          className="opacity-0 group-hover:opacity-100 transition-opacity material-symbols-outlined text-xs"
          title="Rename"
        >edit</button>
      )}
      {muted && (
        <span className="material-symbols-outlined text-xs">visibility_off</span>
      )}
    </div>
  )
}

function shortSubject(s: string): string {
  const parts = s.split('.')
  if (parts.length <= 3) return s
  return '…' + parts.slice(-2).join('.')
}
