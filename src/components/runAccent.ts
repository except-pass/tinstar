export const DEFAULT_RUN_ACCENT = '#00f0ff'

function normalizeHexColor(color?: string): string | null {
  if (!color) return null
  const trimmed = color.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase()
  return null
}

export function resolveRunAccent(color?: string): string {
  return normalizeHexColor(color) ?? DEFAULT_RUN_ACCENT
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = resolveRunAccent(hex)
  const n = Number.parseInt(normalized.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
