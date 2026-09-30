import type { ReactNode } from 'react'
import { QuotaRail } from '../QuotaRail'
import type { ContextPanelMode } from './types'

const copy: Record<Exclude<ContextPanelMode, null>, { title: string; lede: string }> = {
  needs: { title: 'Needs You', lede: 'Action required before workers can proceed.' },
  messages: { title: 'Messages', lede: 'Receipts from notes sent to First Mate.' },
  workers: { title: 'Workers', lede: 'Switch the worker on screen.' },
}

export function ContextPanel({ mode, count, onCollapse, children }: {
  mode: Exclude<ContextPanelMode, null>
  count: number
  onCollapse: () => void
  children: ReactNode
}) {
  const panel = copy[mode]
  return <aside className="cockpit-context" aria-label={panel.title}>
    <header className="cockpit-context-header">
      <div>
        <div className="cockpit-context-title"><strong>{panel.title}</strong><span className={mode === 'needs' ? undefined : 'is-quiet'}>{count}</span></div>
        <p>{panel.lede}</p>
      </div>
      <button type="button" aria-label="Close panel" onClick={onCollapse}><span className="material-symbols-outlined" aria-hidden="true">close</span><span>Close</span></button>
    </header>
    <div className="cockpit-context-body">{children}</div>
    <QuotaRail />
  </aside>
}
