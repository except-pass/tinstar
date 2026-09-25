import { PALETTE_COLORS } from '../../components/ColorPalette'

/** Stable palette index for a worker id. Not the list index and not a port. */
export function hashPaletteColor(id: string): string {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const color = PALETTE_COLORS[(hash >>> 0) % PALETTE_COLORS.length]
  return color ?? PALETTE_COLORS[0]!
}

export function displayName(id: string, alias?: string | null): string {
  const trimmed = alias?.trim()
  return trimmed ? trimmed : id
}
