import type { SessionStatus, ProcedureStatus } from '../types'

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

/** Tailwind text color class for procedure status indicators */
export const PROC_STATUS_COLORS: Record<ProcedureStatus, string> = {
  running: 'text-green-400',
  complete: 'text-primary',
  failed: 'text-red-400',
  queued: 'text-amber-400',
  idle: 'text-slate-500',
}
