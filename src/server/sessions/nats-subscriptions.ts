import type { DocumentStore } from '../stores/document-store'
import { buildAgentSubject } from '../nats/subjects'

export interface NatsSubscriptionContext {
  sessionName: string
  spaceId?: string | null
  project?: string | null
  worktree?: string | null
}

export function computeNatsSubscriptions(
  ctx: NatsSubscriptionContext,
  docStore: DocumentStore,
): string[] {
  const BLANK = '_'
  const space = ctx.spaceId ? docStore.getSpace(ctx.spaceId) : null
  const parts = {
    space: sanitizeSubjectToken(space?.name ?? BLANK) || BLANK,
    project: sanitizeSubjectToken(ctx.project ?? BLANK) || BLANK,
    worktree: sanitizeSubjectToken(ctx.worktree ?? BLANK) || BLANK,
  }
  const direct = buildAgentSubject({ ...parts, session: sanitizeSubjectToken(ctx.sessionName) })
  if (!ctx.project || !ctx.worktree) return [direct]
  return [buildAgentSubject(parts), direct]
}

export function sanitizeSubjectToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function diffSubscriptions(
  oldSubs: string[],
  newSubs: string[],
): { add: string[]; remove: string[] } {
  const oldSet = new Set(oldSubs)
  const newSet = new Set(newSubs)
  return {
    add: newSubs.filter(subject => !oldSet.has(subject)),
    remove: oldSubs.filter(subject => !newSet.has(subject)),
  }
}
