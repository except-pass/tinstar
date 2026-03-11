import type { RunStatus, ProcedureStatus } from '../types'

/** Tailwind class for the status indicator dot */
export const STATUS_DOT_CLASSES: Record<RunStatus, string> = {
  active: 'bg-green-400',
  idle: 'bg-slate-400',
  complete: 'bg-primary',
  failed: 'bg-red-400',
  queued: 'bg-amber-400',
}

/** Hex color for the left border accent */
export const STATUS_BORDER_COLORS: Record<RunStatus, string> = {
  active: '#4ade80',
  idle: '#94a3b8',
  complete: '#00f0ff',
  failed: '#f87171',
  queued: '#fbbf24',
}

/** Tailwind text color class for procedure status indicators */
export const PROC_STATUS_COLORS: Record<ProcedureStatus, string> = {
  running: 'text-green-400',
  complete: 'text-primary',
  failed: 'text-red-400',
  queued: 'text-amber-400',
  idle: 'text-slate-500',
}
