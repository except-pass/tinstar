import { forwardRef } from 'react'

export interface TerminalPrimitiveProps {
  sessionId: string
  /** Optional fixed port fallback when there's no managed session id. */
  port?: number
  zoom?: number
}

/** Embeds the ttyd terminal wrapper for a session. Ref forwards the iframe so
 *  the host can focus it (TerminalHandle.focus). */
export const TerminalPrimitive = forwardRef<HTMLIFrameElement, TerminalPrimitiveProps>(
  function TerminalPrimitive({ sessionId, port, zoom = 1 }, ref) {
    const qs = sessionId ? `session=${encodeURIComponent(sessionId)}` : port ? `port=${port}` : ''
    const needsScale = zoom > 1
    return (
      <div className="widget-drag-handle relative h-full w-full overflow-hidden bg-black">
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
    )
  },
)
