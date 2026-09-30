import { Face, identityColor, StateChip } from './present'
import type { Worker } from './types'

export function WorkerList({ workers, currentKey, onOpen }: { workers: Worker[]; currentKey: string | null; onOpen: (key: string) => void }) {
  return <div className="cockpit-worker-list">
    {workers.map(worker => <button type="button" key={worker.key} className={`cockpit-worker-button ${currentKey === worker.key ? 'active' : ''}`} onClick={() => onOpen(worker.key)} style={{ '--worker-color': identityColor(worker.id) } as React.CSSProperties}>
      <Face worker={worker} size={35} /><span className="cockpit-worker-label"><strong>{worker.id}</strong><small>{worker.project}</small></span><StateChip state={worker.state} />
    </button>)}
  </div>
}

export function WorkerSwitcherPanel({ workers, currentKey, query, onQuery, onOpen }: {
  workers: Worker[]
  currentKey: string | null
  query: string
  onQuery: (value: string) => void
  onOpen: (key: string) => void
}) {
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? workers.filter(worker => worker.id.toLowerCase().includes(needle) || worker.project.toLowerCase().includes(needle))
    : workers
  return <>
    <input className="cockpit-jump" aria-label="Jump to worker" placeholder="Search workers" value={query} onChange={event => onQuery(event.target.value)} onKeyDown={event => {
      if (event.key !== 'Enter') return
      const match = workers.find(worker => worker.id.toLowerCase().includes(needle))
      if (match && needle) { onOpen(match.key); onQuery('') }
    }} />
    <WorkerList workers={shown} currentKey={currentKey} onOpen={onOpen} />
    <p className="cockpit-switch-hint">Ctrl+[ / Ctrl+] switches workers</p>
  </>
}
