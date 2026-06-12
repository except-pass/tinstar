// The pin dot — a small numbered/checked button. Presentational only; the parent
// positions its top-left at the pin point and the inline transform both centers it
// (translate -50%,-50%) and counter-scales for canvas zoom so it stays screen-sized.
interface PinMarkerProps {
  id: string; index: number; sent: boolean; accent: string; comment: string
  zoom: number
  onPointerDown: (e: React.PointerEvent) => void
}

export function PinMarker(p: PinMarkerProps) {
  return (
    <button
      data-testid={`pin-marker-${p.id}`}
      data-sent={p.sent ? 'true' : 'false'}
      onPointerDown={p.onPointerDown}
      className={`w-5 h-5 rounded-full border text-[10px] font-mono font-bold flex items-center justify-center shadow transition-transform hover:scale-110 ${
        p.sent ? 'bg-slate-700 border-slate-500 text-slate-400' : 'text-white border-white/40'
      }`}
      style={{ ...(p.sent ? {} : { background: p.accent }), transform: `translate(-50%, -50%) scale(${1 / p.zoom})` }}
      title={p.sent ? `Sent — ${p.comment}` : p.comment || 'Click to edit'}
    >
      {p.sent ? '✓' : p.index}
    </button>
  )
}
