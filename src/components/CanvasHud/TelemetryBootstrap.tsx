import './hud.css'
import type { HudSnapshot } from '../../server/observability/types'

interface Props { snap: HudSnapshot; onRetry: () => void }

export function TelemetryBootstrap({ snap, onRetry }: Props) {
  if (snap.state === 'downloading') {
    const bytes = (snap.progress ?? []).reduce((s, p) => s + p.bytesReceived, 0)
    const total = (snap.progress ?? []).reduce((s, p) => s + p.bytesTotal, 0)
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
    return (
      <div className="hud-line" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div style={{ fontSize: 10, letterSpacing: 2, opacity: 0.6 }}>DOWNLOADING TELEMETRY</div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', marginTop: 4 }}>
          {mb(bytes)} / {mb(total)} MB
        </div>
      </div>
    )
  }
  if (snap.state === 'starting') {
    return <div style={{ padding: 10, opacity: 0.65 }}>warming up…</div>
  }
  if (snap.state === 'degraded' || snap.state === 'download-failed') {
    return (
      <div style={{ padding: 10 }}>
        <div style={{ color: '#fbbf24' }}>⚠ telemetry {snap.state === 'degraded' ? 'degraded' : 'failed'}</div>
        {snap.error && <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>{snap.error}</div>}
        <button onClick={onRetry} style={{ marginTop: 6 }}>Retry</button>
      </div>
    )
  }
  return null
}
