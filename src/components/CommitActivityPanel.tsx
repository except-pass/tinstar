import type { CommitRecord } from '../types'

interface Props {
  commits: CommitRecord[]
  mode: 'task' | 'unassigned' | 'standup'
  selectedTaskTag: string
  onTaskTagChange: (tag: string) => void
}

export function CommitActivityPanel({ commits, mode, selectedTaskTag, onTaskTagChange }: Props) {
  const taskTags = Array.from(new Set(commits.flatMap(c => c.taskTags))).sort()
  const sorted = [...commits].sort((a, b) => new Date(b.authorDate).getTime() - new Date(a.authorDate).getTime())

  const forTask = selectedTaskTag ? sorted.filter(c => c.taskTags.includes(selectedTaskTag)) : []
  const unassigned = sorted.filter(c => c.taskTags.length === 0)

  const standupGroups = taskTags.map(tag => ({ tag, commits: sorted.filter(c => c.taskTags.includes(tag)) }))

  return (
    <div className="border-t border-white/10 bg-surface-panel p-3 text-xs max-h-64 overflow-y-auto" data-testid="commit-activity-panel">
      {mode === 'task' && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-slate-400">Task Activity</span>
            <select
              className="bg-surface-base border border-white/10 rounded px-2 py-1"
              value={selectedTaskTag}
              onChange={(e) => onTaskTagChange(e.target.value)}
            >
              <option value="">Select task tag</option>
              {taskTags.map(tag => <option key={tag} value={tag}>#{tag}</option>)}
            </select>
          </div>
          <ul className="space-y-1">
            {forTask.map(c => (
              <li key={c.sha} className="text-slate-300">
                <span className="text-primary">{c.subject}</span> · {c.authorName} · {new Date(c.authorDate).toLocaleString()} · {c.repo}/{c.branch}
              </li>
            ))}
          </ul>
        </>
      )}

      {mode === 'unassigned' && (
        <>
          <div className="mb-2 text-slate-400">Unassigned Commits</div>
          <ul className="space-y-1">
            {unassigned.map(c => (
              <li key={c.sha} className="text-slate-300">{c.subject} · {c.authorName} · {new Date(c.authorDate).toLocaleString()}</li>
            ))}
          </ul>
        </>
      )}

      {mode === 'standup' && (
        <>
          <div className="mb-2 text-slate-400">Stand-up Summary</div>
          <div className="space-y-2">
            {standupGroups.map(group => (
              <div key={group.tag}>
                <div className="text-primary">#{group.tag}</div>
                <ul className="ml-3 list-disc">
                  {group.commits.map(c => <li key={`${group.tag}-${c.sha}`}>{c.subject}</li>)}
                </ul>
              </div>
            ))}
            {unassigned.length > 0 && (
              <div>
                <div className="text-primary">Unassigned</div>
                <ul className="ml-3 list-disc">
                  {unassigned.map(c => <li key={`u-${c.sha}`}>{c.subject}</li>)}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
