export const VIEW_PREFIX = 'v6view-'
export const V5_VIEW_PREFIX = 'tsview-'

const DENIED_SESSIONS = new Set(['firstmate', 'serena-view', 'kd-live'])

/** Why this tmux session must not be linked. Null means the name is usable. */
export function sessionNameRefusal(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'bad session name'
  if (DENIED_SESSIONS.has(name)) return 'refused session'
  if (name.startsWith(VIEW_PREFIX) || name.startsWith(V5_VIEW_PREFIX)) return 'refusing to view a view'
  if (VIEW_PREFIX.startsWith(name) || V5_VIEW_PREFIX.startsWith(name)) {
    return 'session name would prefix-match view names'
  }
  return null
}

export function windowNameAllowed(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name)
}

export function socketNameAllowed(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name)
}

export interface WindowRef {
  session: string
  windowName: string
}

/** `session:window` from a snapshot endpoint target. Anything else is unusable. */
export function parseEndpointTarget(target: string | null | undefined): WindowRef | null {
  if (!target) return null
  const match = target.match(/^([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/)
  if (!match) return null
  const session = match[1]!
  const windowName = match[2]!
  if (sessionNameRefusal(session) || !windowNameAllowed(windowName)) return null
  return { session, windowName }
}

export function v6TmuxSocket(): string | null {
  const name = process.env.TINSTAR_V6_TMUX_SOCKET?.trim() ?? ''
  if (!socketNameAllowed(name)) return null
  return name
}
