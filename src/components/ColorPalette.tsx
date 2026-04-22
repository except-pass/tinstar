// 8 hues × 3 shades (light → mid → dark), one-click selection
const PALETTE: { name: string; shades: [string, string, string] }[] = [
  { name: 'Cyan',   shades: ['#7df9ff', '#00f0ff', '#007a8a'] },
  { name: 'Green',  shades: ['#b7ff9e', '#00ff88', '#00844a'] },
  { name: 'Amber',  shades: ['#ffd580', '#ffaa00', '#b36b00'] },
  { name: 'Red',    shades: ['#ff9e9e', '#ff5555', '#cc2200'] },
  { name: 'Pink',   shades: ['#ff79c6', '#ff2e88', '#a8005a'] },
  { name: 'Purple', shades: ['#e0c3fc', '#bd93f9', '#5b21b6'] },
  { name: 'Blue',   shades: ['#93c5fd', '#4d9de0', '#1d5a99'] },
  { name: 'Slate',  shades: ['#cbd5e1', '#94a3b8', '#334155'] },
]

export const PALETTE_COLORS: string[] = PALETTE.flatMap(h => h.shades)

export function pickRandomPaletteColor(): string {
  return PALETTE_COLORS[Math.floor(Math.random() * PALETTE_COLORS.length)]
}

interface Props {
  value: string
  onChange: (color: string) => void
}

export function ColorPalette({ value, onChange }: Props) {
  return (
    <div className="space-y-2">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4 }}>
        {([0, 1, 2] as const).flatMap(shadeIdx =>
          PALETTE.map(hue => {
            const color = hue.shades[shadeIdx]
            return (
              <button
                key={color}
                type="button"
                title={`${hue.name} — ${color}`}
                onClick={() => onChange(color)}
                style={{ background: color }}
                className={`aspect-square rounded-sm border-2 transition-transform hover:scale-110 ${
                  value.toLowerCase() === color.toLowerCase()
                    ? 'border-white'
                    : 'border-transparent'
                }`}
              />
            )
          })
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(pickRandomPaletteColor())}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-white/10 bg-surface-base text-xs text-slate-300 hover:text-slate-100 hover:border-white/20 hover:bg-white/5 transition-colors"
        title="Pick a random color from the palette"
      >
        <span className="material-symbols-outlined text-sm">casino</span>
        Random
      </button>
    </div>
  )
}
