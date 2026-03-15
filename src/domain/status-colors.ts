import type { SessionStatus } from '../types'

/** Tailwind class for the status indicator dot */
export const STATUS_DOT_CLASSES: Record<SessionStatus, string> = {
  creating: 'bg-blue-400',
  running: 'bg-green-400',
  idle: 'bg-amber-400',
  needs_attention: 'bg-orange-400',
  stopped: 'bg-slate-500',
}

/** Hex color for the left border accent */
export const STATUS_BORDER_COLORS: Record<SessionStatus, string> = {
  creating: '#818cf8',
  running: '#4ade80',
  idle: '#fbbf24',
  needs_attention: '#f97316',
  stopped: '#64748b',
}

