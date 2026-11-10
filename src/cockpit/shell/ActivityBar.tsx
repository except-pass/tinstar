import { QuotaBadges } from '../QuotaRail'
export function ActivityBar({ reviewOpen, onReview, reviewCount = null, overviewActive, onOverview, decisionsActive = false, onDecisions, pullsActive = false, onPulls, releasesActive = false, releaseCount = null, onReleases }: {
  reviewOpen?: boolean; onReview?: () => void; reviewCount?: number | null
  overviewActive: boolean; onOverview: () => void
  decisionsActive?: boolean; onDecisions?: () => void
  pullsActive?: boolean; onPulls?: () => void
  releasesActive?: boolean; releaseCount?: number | null; onReleases?: () => void
}) {
  return <nav className="cockpit-activity" aria-label="Activity">
    <div className="cockpit-activity-brand" title="Tin Star"><span className="cockpit-brand-mark" aria-hidden="true">✦</span><span className="cockpit-activity-name">Tin Star</span></div>
    <button type="button" className={`cockpit-activity-button cockpit-overview-button${overviewActive ? ' active' : ''}`} aria-current={overviewActive ? 'page' : undefined} title="Overview" onClick={onOverview}>
      <span className="material-symbols-outlined" aria-hidden="true">dashboard</span><span className="cockpit-activity-label">Overview</span>
    </button>
    {onDecisions && <button type="button" className={`cockpit-activity-button${decisionsActive ? ' active' : ''}`} aria-current={decisionsActive ? 'page' : undefined} title="Decisions" onClick={onDecisions}>
      <span className="material-symbols-outlined" aria-hidden="true">rule</span><span className="cockpit-activity-label">Decisions</span>
    </button>}
    {onPulls && <button type="button" className={`cockpit-activity-button${pullsActive ? ' active' : ''}`} aria-current={pullsActive ? 'page' : undefined} title="PRs" onClick={onPulls}>
      <span className="material-symbols-outlined" aria-hidden="true">account_tree</span><span className="cockpit-activity-label">PRs</span>
    </button>}
    {onReleases && <button type="button" className={`cockpit-activity-button${releasesActive ? ' active' : ''}`} aria-current={releasesActive ? 'page' : undefined} aria-label={`Releases${releaseCount === null ? ', count unknown' : `, ${releaseCount} unique PRs awaiting production evidence`}`} title="Releases" onClick={onReleases}>
      <span className="material-symbols-outlined" aria-hidden="true">rocket_launch</span><span className="cockpit-activity-label">Releases</span>
      <span className="cockpit-activity-count is-quiet" aria-hidden="true">{releaseCount ?? '?'}</span>
    </button>}
    {onReview && <button type="button" className={`cockpit-activity-button${reviewOpen ? ' active' : ''}`} aria-expanded={!!reviewOpen} aria-controls="cockpit-context" title="Review Ready" onClick={onReview}>
      <span className="material-symbols-outlined" aria-hidden="true">rate_review</span><span className="cockpit-activity-label">Review Ready</span><span aria-hidden="true">{reviewCount ?? '?'}</span>
    </button>}
    <QuotaBadges />
  </nav>
}
