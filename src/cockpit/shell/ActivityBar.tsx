import { QuotaBadges } from '../QuotaRail'
import type { ContextPanelMode } from './types'

type PanelTool = Exclude<ContextPanelMode, null>

const tools: Array<{ mode: PanelTool; label: string; lines: string[]; icon: string }> = [
  { mode: 'needs', label: 'Needs You', lines: ['Needs', 'You'], icon: 'priority_high' },
  { mode: 'messages', label: 'Messages', lines: ['Messages'], icon: 'chat' },
  { mode: 'workers', label: 'Workers', lines: ['Workers'], icon: 'groups' },
]

export function ActivityBar({ overviewActive, panelMode, counts, messageAttention = 0, onOverview, onSelect }: {
  overviewActive: boolean
  panelMode: ContextPanelMode
  counts: Record<PanelTool, number>
  /** Messages that still need a retry. The receipt total stays a quiet tally. */
  messageAttention?: number
  onOverview: () => void
  onSelect: (mode: PanelTool) => void
}) {
  return <nav className="cockpit-activity" aria-label="Activity">
    <div className="cockpit-activity-brand" title="Tin Star"><span className="cockpit-brand-mark" aria-hidden="true">✦</span><span className="cockpit-activity-name">Tin Star</span></div>
    <button type="button" className={`cockpit-activity-button cockpit-overview-button${overviewActive ? ' active' : ''}`} aria-current={overviewActive ? 'page' : undefined} title="Overview" onClick={onOverview}>
      <span className="material-symbols-outlined" aria-hidden="true">dashboard</span>
      <span className="cockpit-activity-label"><span className="cockpit-activity-line">Overview</span></span>
    </button>
    {tools.map(tool => {
      const total = counts[tool.mode]
      const alert = tool.mode === 'needs' || (tool.mode === 'messages' && messageAttention > 0)
      const count = tool.mode === 'messages' && messageAttention > 0 ? messageAttention : total
      const open = panelMode === tool.mode
      const name = count > 0 ? `${tool.label}, ${count}` : tool.label
      return <button type="button" key={tool.mode} className={`cockpit-activity-button${open ? ' is-panel' : ''}`} aria-pressed={open} aria-label={name} title={name} onClick={() => onSelect(tool.mode)}>
        <span className="material-symbols-outlined" aria-hidden="true">{tool.icon}</span>
        <span className="cockpit-activity-label" aria-hidden="true">{tool.lines.map(line => <span key={line} className="cockpit-activity-line">{line}</span>)}</span>
        {count > 0 && <span className={`cockpit-activity-count${alert ? ' is-alert' : ' is-quiet'}`} aria-hidden="true">{count}</span>}
      </button>
    })}
    <QuotaBadges />
  </nav>
}
