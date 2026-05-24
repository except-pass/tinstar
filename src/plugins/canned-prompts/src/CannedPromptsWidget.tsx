// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'

const CANNED = [
  { label: 'Re-run last test', text: 'rerun the most recent failing test' },
  { label: 'Explain this',     text: 'explain what just happened in plain english' },
  { label: 'Commit',           text: 'commit the current changes with a descriptive message' },
]

export function makeCannedPromptsWidget(api: TinstarPluginAPI) {
  const ConstellationBadge = api.constellations.Badge

  return function CannedPromptsWidget(_props: WidgetProps) {
    const mySlots = api.constellations.useMySlots()
    const peers = api.constellations.usePeers()
    const invoke = api.constellations.useInvokePeerCapability()

    // Find a peer that exposes session.prompt — typically a run widget.
    const sessionPeer = peers.find((p) => p.capabilities.includes('session.prompt'))

    return (
      <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
          <span className="text-primary text-xs">⌨</span>
          <span className="text-2xs font-mono text-slate-400 flex-1 truncate">
            {sessionPeer ? `Canned Prompts → ${sessionPeer.id}` : 'Canned Prompts'}
          </span>
          <ConstellationBadge slots={mySlots} />
        </div>

        {sessionPeer ? (
          <div className="p-2 flex flex-col gap-1 flex-1 overflow-auto">
            {CANNED.map(({ label, text }) => (
              <button
                key={label}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                className="text-left text-sm px-2 py-1 rounded border border-primary/20 hover:bg-primary/10 hover:border-primary/60 transition-colors"
                onClick={() => {
                  invoke(sessionPeer.id, 'session.prompt', { text }).catch((err) => {
                    api.logger.warn('canned-prompts invoke failed', err)
                  })
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <div className="p-3 text-sm text-slate-400 flex-1 flex items-center justify-center text-center">
            Drag me into a constellation with a session widget to wire up.
          </div>
        )}
      </div>
    )
  }
}
