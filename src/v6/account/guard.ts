export const REFUSED_KEYS = new Set([
  'command',
  'shell',
  'argv',
  'cmd',
  'tmux',
  'tmuxTarget',
  'target',
])

const BANNED_OPS = new Set([
  'spawn',
  'kill',
  'exec',
  'stop',
  'shell',
  'tmux',
  'fm-control',
  'fm-teardown',
  'fm-spawn',
  'send-keys',
])

export type AccountRoute =
  | 'board'
  | 'epic-read'
  | 'epic-completion'
  | 'sample'
  | 'acknowledge'
  | 'rebudget'
  | 'schedule-read'

const ROUTE_OPS: Record<AccountRoute, string> = {
  board: 'board.read',
  'epic-read': 'epic.read',
  'epic-completion': 'epic.set-completed',
  sample: 'schedule.sample',
  acknowledge: 'schedule.acknowledge',
  rebudget: 'schedule.rebudget',
  'schedule-read': 'schedule.read',
}

export function operationRefusal(route: AccountRoute, op: string | null): string | null {
  if (op === null) return null
  if (BANNED_OPS.has(op) || ROUTE_OPS[route] !== op) return `operation ${op} is not allowlisted`
  return null
}

/** Reject a command string, a raw tmux target, or an operation outside this route. */
export function payloadRefusal(value: unknown, route: AccountRoute, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = payloadRefusal(item, route, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (REFUSED_KEYS.has(key)) return `${key} is not accepted`
    if (key === 'op' || key === 'operation') {
      if (typeof inner !== 'string') return 'operation must be a string'
      const reason = operationRefusal(route, inner)
      if (reason) return reason
    }
    const nested = payloadRefusal(inner, route, depth + 1)
    if (nested) return nested
  }
  return null
}

export function queryRefusal(params: Iterable<[string, string]>, route: AccountRoute): string | null {
  let op: string | null = null
  for (const [key, value] of params) {
    if (REFUSED_KEYS.has(key)) return `${key} is not accepted`
    if (key === 'op' || key === 'operation') op = value
  }
  return operationRefusal(route, op)
}
