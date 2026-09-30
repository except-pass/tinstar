import { QuotaBadges } from '../QuotaRail'
import type { ContextPanelMode } from './types'

type PanelTool = Exclude<ContextPanelMode, null>

const tools: Array<{ mode: PanelTool; label: string; icon: string }> = [
  { mode: 'needs', label: 'Needs You', icon: 'priority_high' },
  { mode: 'messages', label: 'Messages', icon: 'chat' },
  { mode: 'workers', label: 'Workers', icon: 'groups' },
]

export function ActivityBar({ overviewActive, panelMode, counts, onOverview, onSelect }: {
  overviewActive: boolean
  panelMode: ContextPanelMode
  counts: Record<PanelTool, number>
  onOverview: () => void
  onSelect: (mode: PanelTool) => void
}) {
  return <nav className="cockpit-activity" aria-label="Activity">
    <div className="cockpit-activity-brand" title="Tin Star"><span className="cockpit-brand-mark" aria-hidden="true">✦</span><span className="cockpit-activity-name">Tin Star</span></div>
    <button type="button" className={`cockpit-activity-button cockpit-overview-button${overviewActive ? ' active' : ''}`} aria-current={overviewActive ? 'page' : undefined} onClick={onOverview}>
      <span className="material-symbols-outlined" aria-hidden="true">dashboard</span>
      <span>Overview</span>
    </button>
    {tools.map(tool => {
      const count = counts[tool.mode]
      const open = panelMode === tool.mode
      return <button type="button" key={tool.mode} className={`cockpit-activity-button${open ? ' is-panel' : ''}`} aria-pressed={open} aria-label={count > 0 ? `${tool.label}, ${count}` : tool.label} onClick={() => onSelect(tool.mode)}>
        <span className="material-symbols-outlined" aria-hidden="true">{tool.icon}</span>
        <span aria-hidden="true">{tool.label}</span>
        {count > 0 && <span className="cockpit-activity-count" aria-hidden="true">{count}</span>}
      </button>
    })}
    <QuotaBadges />
  </nav>
}
