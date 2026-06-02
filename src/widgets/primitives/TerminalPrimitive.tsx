import { forwardRef } from 'react'

export interface TerminalPrimitiveProps {
  sessionId: string
  /** Optional fixed port fallback when there's no managed session id. */
  port?: number
  zoom?: number
}

export const TerminalPrimitive = forwardRef<HTMLIFrameElement, TerminalPrimitiveProps>(
  function TerminalPrimitive({ sessionId, port, zoom = 1 }, ref) {
    const qs = sessionId ? `session=${encodeURIComponent(sessionId)}` : port ? `port=${port}` : ''
    const needsScale = zoom > 1
    const label = sessionId || (port ? `:${port}` : 'terminal')
    return (
      <div className="flex flex-col h-full w-full overflow-hidden bg-black">
        {/* Drag handle header — the only place the widget can be grabbed, since the
            iframe below captures all pointer events for the terminal itself. */}
        <div className="widget-drag-handle flex items-center gap-1.5 px-3 py-2 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
          <span className="material-symbols-outlined text-sm text-slate-400 flex-shrink-0">terminal</span>
          <span className="text-xs font-mono text-slate-400 truncate">{label}</span>
        </div>
        <div className="relative flex-1 min-h-0">
          <div
            style={needsScale
              ? { position: 'absolute', inset: 0, width: `${zoom * 100}%`, height: `${zoom * 100}%`, transformOrigin: '0 0', transform: `scale(${1 / zoom})` }
              : { position: 'absolute', inset: 0 }}
          >
            <iframe
              ref={ref}
              src={`/terminal-wrapper.html?${qs}`}
              style={{ display: 'block', width: '100%', height: '100%', border: 0, background: 'black' }}
              title="Terminal"
              allow="clipboard-read; clipboard-write"
            />
          </div>
        </div>
      </div>
    )
  },
)
