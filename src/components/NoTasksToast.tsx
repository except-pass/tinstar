import { useState, useEffect } from 'react'

const DISMISSED_KEY = 'tinstar-no-tasks-nudge-dismissed'

export function NoTasksToast({ taskCount, runCount }: { taskCount: number; runCount: number }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (runCount > 0 && taskCount === 0 && !localStorage.getItem(DISMISSED_KEY)) {
      setVisible(true)
    }
  }, [taskCount, runCount])

  if (!visible) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-surface-raised border border-white/10 rounded-lg shadow-lg p-4 text-xs text-slate-300">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-slate-200 font-medium mb-1">Tip: Tinstar works best with tasks</p>
          <p className="text-slate-400">They help organize your agents' work and track progress.</p>
        </div>
        <button
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, '1')
            setVisible(false)
          }}
          className="text-slate-500 hover:text-slate-300 shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
