import { classifySubject, type SubjectRole } from './subjectRole'

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
      {subscriptions.map(subject => {
        const role = classifySubject(subject, sessionName)
        const muted = mutedSet.has(subject)
        return (
          <div
            key={subject}
            data-testid="saloon-topic"
            data-role={role}
            data-muted={muted ? 'true' : 'false'}
            title={subject}
            onClick={() => onToggleMute(subject)}
            className={`px-2 py-1 text-2xs font-mono truncate border-l-2 cursor-pointer hover:bg-primary/5 transition-opacity ${ROLE_COLOR[role]} ${muted ? 'opacity-40' : ''}`}
          >
            <span>{shortSubject(subject)}</span>
            {muted && (
              <span className="material-symbols-outlined text-xs ml-1 align-middle">visibility_off</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function shortSubject(s: string): string {
  const parts = s.split('.')
  if (parts.length <= 3) return s
  return '…' + parts.slice(-2).join('.')
}
