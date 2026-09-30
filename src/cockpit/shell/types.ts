import type { AttentionCard as FleetAttentionCard } from '../../server/fleet/attention'

export interface Worker {
  key: string; id: string; home: string; kind: string; state: string; detail: string
  observedAt: string | null; freshness: string; objective: string; project: string; direct: boolean
  worktree: string; branch: string; prUrl: string | null; terminalAvailable: boolean; terminalPid: number | null
}

export type AttentionCard = FleetAttentionCard & { home: string | null }

export interface OutboxMessage {
  requestId: string; home: string; taskId: string | null; decisionKey: string | null
  kind: 'answer' | 'message'; text: string
  state: 'unknown' | 'sending' | 'saved' | 'acknowledged' | 'done'
  announced: boolean | null; reply: string | null; canReceive: boolean | 'unknown'
}

export type Draft = { requestId: string; anchorKey?: string; kind: 'answer' | 'message'; text: string }
export type SubmitResult = { saved: boolean; error: string | null; canReceive: boolean | 'unknown' }

/** `null` is the collapsed context panel. It is not part of the page URL. */
export type ContextPanelMode = 'needs' | 'messages' | 'workers' | null

/** Overview opens Needs You. A worker route opens the switcher. */
export function defaultPanelMode(worker: string | null): Exclude<ContextPanelMode, null> {
  return worker ? 'workers' : 'needs'
}

/** Below this width the context panel is a drawer and starts closed. */
export const DRAWER_MEDIA = '(max-width: 1099px)'

export function isDrawerLayout(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DRAWER_MEDIA).matches
}

/** A narrow window starts with the canvas clear. Wide desktop opens the matching panel. */
export function initialPanelMode(worker: string | null, drawer = isDrawerLayout()): ContextPanelMode {
  return drawer ? null : defaultPanelMode(worker)
}
