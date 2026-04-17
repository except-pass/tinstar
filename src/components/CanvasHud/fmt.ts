const SUFFIXES = ['', 'k', 'M', 'B', 'T'] as const

export function fmtNum(n: number): string {
  if (n === 0) return '0'
  const abs = Math.abs(n)
  const tier = Math.min(Math.floor(Math.log10(abs) / 3), SUFFIXES.length - 1)
  if (tier === 0) return Math.round(n).toLocaleString()
  const scaled = n / Math.pow(10, tier * 3)
  return `${scaled.toFixed(1)}${SUFFIXES[tier]}`
}

export function fmtDollar(n: number): string {
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

export function fmtRate(n: number): string {
  return fmtNum(Math.round(n))
}
