import { useMemo } from 'react'
import { useServerEvents } from './useServerEvents'
import { getInboxReadKeys } from '../lib/uiPrefs'
import type { AttentionState, AttentionLevel, PluginWidgetInstance, Run, SessionStatus } from '../domain/types'

export interface InboxRow {
  widgetId: string
  source: 'plugin' | 'run'
  widgetType: string
  sourceLabel: string
  /** Present only while the item is actively requesting attention; null for a session that's just listed for visibility. */
  attention: AttentionState | null
  /** Session status, for rows with no pending attention. null for plugin widgets. */
  status: SessionStatus | null
  /** Run accent color (hex), drives the avatar + selection bar. null for plugin widgets. */
  color: string | null
  /** Session creation time, used as the timestamp for non-attention rows. */
  createdAt: string | null
  /** Stable key for read-tracking (attention rows churn this per attention event). */
  readKey: string
  unread: boolean
  taskPath: string[]
  sessionName: string | null
  worktree: string | null
}

const LEVEL_ORDER: Record<AttentionLevel, number> = {
  urgent: 0,
  attention: 1,
  info: 2,
}

export interface UseInboxResult {
  rows: InboxRow[]
  unreadCount: number
}

export function useInbox(activeSpaceId: string | null | undefined): UseInboxResult {
  const { state } = useServerEvents()

  return useMemo(() => {
    if (!activeSpaceId) return { rows: [], unreadCount: 0 }

    const readKeys = getInboxReadKeys()
    const rows: InboxRow[] = []

    // Plugin widgets surface in the inbox only while they're actively
    // requesting attention — they aren't sessions.
    for (const pw of state.pluginWidgets as PluginWidgetInstance[]) {
      if (pw.spaceId !== activeSpaceId || !pw.attention) continue
      const readKey = `${pw.id}:${pw.attention.setAt}`
      rows.push({
        widgetId: pw.id,
        source: 'plugin',
        widgetType: pw.widgetType,
        sourceLabel: pw.widgetType,
        attention: pw.attention,
        status: null,
        color: null,
        createdAt: pw.attention.setAt,
        readKey,
        unread: !readKeys.has(readKey),
        taskPath: [],
        sessionName: null,
        worktree: null,
      })
    }

    // Every session in the space shows — like an email inbox listing all
    // mail, not just unread. Sessions needing attention sort to the top;
    // the rest list below by recency so you can see everything at a glance.
    for (const run of state.runs as Run[]) {
      if (run.spaceId !== activeSpaceId) continue
      // Background sessions never produce passive listing rows — even when the
      // reveal toggle is on (R6). A run with pending attention flows through
      // unchanged: that's the breakthrough row (R11/R16).
      if (run.background && !run.attention) continue
      const taskPath = [run.initiative, run.epic, run.task].filter(s => typeof s === 'string' && s.length > 0)
      const readKey = run.attention ? `${run.id}:${run.attention.setAt}` : run.id
      rows.push({
        widgetId: run.id,
        source: 'run',
        widgetType: 'run',
        sourceLabel: run.id,
        attention: run.attention ?? null,
        status: run.status,
        color: run.color ?? null,
        createdAt: run.createdAt ?? null,
        readKey,
        // Sessions with no pending attention aren't "unread" — they're just
        // present for visibility, so they render in the muted/read style.
        unread: run.attention ? !readKeys.has(readKey) : false,
        taskPath,
        sessionName: run.sessionId ?? null,
        worktree: run.worktree ?? null,
      })
    }

    rows.sort((a, b) => {
      // Attention items first, ordered by level then recency.
      const aHas = a.attention ? 0 : 1
      const bHas = b.attention ? 0 : 1
      if (aHas !== bHas) return aHas - bHas
      if (a.attention && b.attention) {
        const lvl = LEVEL_ORDER[a.attention.level] - LEVEL_ORDER[b.attention.level]
        if (lvl !== 0) return lvl
        return b.attention.setAt.localeCompare(a.attention.setAt)
      }
      // Both without attention: newest session first.
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    })

    return { rows, unreadCount: rows.filter(r => r.unread).length }
  }, [state.pluginWidgets, state.runs, activeSpaceId])
}
