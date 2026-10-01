import type { QuotaWindowReading } from '../server/quota/parse'

const WIDTH = 180

/** A quota cycle drawn against elapsed time, whatever its reported length. */
export function WindowRaceBar({ window, now }: { window: QuotaWindowReading | null; now: number }) {
  const start = window?.startsAt ? Date.parse(window.startsAt) : Number.NaN
  const reset = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
  const elapsed = Number.isFinite(start) && Number.isFinite(reset) && reset > start
    ? Math.max(0, Math.min(1, (now - start) / (reset - start)))
    : null
  const remaining = window?.remainingPercent == null ? null : Math.max(0, Math.min(1, window.remainingPercent / 100))
  const used = remaining == null ? null : 1 - remaining
  const deficit = used != null && elapsed != null ? used - elapsed : 0
  const color = deficit > 0.20 ? '#ef4444' : deficit > 0 ? '#f97316' : '#f59e0b'

  return <svg className="cockpit-quota-race" viewBox={`0 0 ${WIDTH} 16`} preserveAspectRatio="none" aria-hidden="true">
    <rect x="0" y="3" width={WIDTH} height="10" rx="2" fill="rgba(255,255,255,0.12)" />
    {used != null && <rect x={used * WIDTH} y="3" width={remaining! * WIDTH} height="10" rx="2" fill={color} />}
    {deficit > 0 && elapsed != null && <rect x={elapsed * WIDTH} y="3" width={deficit * WIDTH} height="10" fill={`${color}55`} />}
    {elapsed != null && <line x1={elapsed * WIDTH} x2={elapsed * WIDTH} y1="1" y2="15" stroke="#f1f5f9" strokeWidth="1.5" />}
  </svg>
}
