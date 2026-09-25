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

/** The name, color, project, and worktree the rail already resolved for one worker. */
export interface ShellWorkerIdentity {
  name: string
  color: string
  project: string
  worktree: string
}

export interface TerminalIdentityMessage {
  type: 'v6-worker-identity'
  worker: string
  name: string
  color: string
  face: string | null
  project: string
  worktree: string
}

/**
 * Name and color travel in the query string.
 * The face is posted later so a late avatar does not reload the session.
 */
export function terminalDocumentSrc(workerId: string, identity: ShellWorkerIdentity): string {
  const params = new URLSearchParams()
  params.set('worker', workerId)
  params.set('name', identity.name)
  params.set('color', identity.color)
  params.set('project', identity.project)
  params.set('worktree', identity.worktree)
  return `/v6-terminal-wrapper.html?${params.toString()}`
}

export function terminalIdentityMessage(
  workerId: string,
  identity: ShellWorkerIdentity,
  face: string | null,
): TerminalIdentityMessage {
  return {
    type: 'v6-worker-identity',
    worker: workerId,
    name: identity.name,
    color: identity.color,
    face,
    project: identity.project,
    worktree: identity.worktree,
  }
}
