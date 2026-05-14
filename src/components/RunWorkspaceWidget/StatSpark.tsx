import { Sparkline } from './Sparkline'
import type { DeltaChip, ChipTone } from './computeDeltaChip'

export type StatAccent = 'gold' | 'blue' | 'green' | 'violet'

interface Props {
  accent: StatAccent
  label: string
  value: string
  /** Oldest → newest. `null` = missing sample (gap). */
  series: (number | null)[]
  delta: DeltaChip | null
}

const ACCENT_HEX: Record<StatAccent, string> = {
  gold:   '#f6c155',
  blue:   '#58c8ff',
  green:  '#5ee2a0',
  violet: '#b18cff',
}
const ACCENT_GLOW: Record<StatAccent, string> = {
  gold:   'rgba(246,193,85,0.42)',
  blue:   'rgba(88,200,255,0.42)',
  green:  'rgba(94,226,160,0.42)',
  violet: 'rgba(177,140,255,0.42)',
}
const TONE_BG: Record<ChipTone, string> = {
  up:   'rgba(94,226,160,0.16)',
  dn:   'rgba(255,119,102,0.16)',
  flat: 'rgba(207,214,228,0.10)',
}
const TONE_FG: Record<ChipTone, string> = {
  up:   '#5ee2a0',
  dn:   '#ff7766',
  flat: 'rgba(207,214,228,0.55)',
}

export function StatSpark({ accent, label, value, series, delta }: Props) {
  const hex = ACCENT_HEX[accent]
  const glow = ACCENT_GLOW[accent]
  const chipTone: ChipTone = delta?.tone ?? 'flat'
  const chipText = delta?.text ?? '—'
  return (
    <div
      data-testid="stat-spark"
      style={{
        position: 'relative',
        padding: '6px 10px 0',
        border: '1px solid rgba(120,140,180,0.15)',
        borderRadius: 4,
        background: 'rgba(8,12,22,0.55)',
        minHeight: 64,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: 2,
          color: 'rgba(207,214,228,0.30)',
          textTransform: 'uppercase',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{label}</span>
        <span
          className={chipTone}
          style={{
            fontSize: 9,
            letterSpacing: 1,
            padding: '1px 5px',
            borderRadius: 2,
            fontVariantNumeric: 'tabular-nums',
            background: TONE_BG[chipTone],
            color: TONE_FG[chipTone],
          }}
        >
          {chipText}
        </span>
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 500,
          letterSpacing: '-0.5px',
          marginTop: 2,
          color: '#cfd6e4',
          textShadow: `0 0 10px ${glow}`,
          fontVariantNumeric: 'tabular-nums',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {value}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 28,
          pointerEvents: 'none',
        }}
      >
        <Sparkline data={series} accent={hex} />
      </div>
    </div>
  )
}
