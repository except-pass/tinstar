import { useMemo } from 'react'
import { useServerEvents } from './useServerEvents'
import { getInboxReadKeys } from '../lib/uiPrefs'
import type { AttentionState, AttentionLevel, PluginWidgetInstance, Run } from '../domain/types'

export interface InboxRow {
  widgetId: string
  source: 'plugin' | 'run'
  widgetType: string
  sourceLabel: string
  attention: AttentionState
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

    for (const pw of state.pluginWidgets as PluginWidgetInstance[]) {
      if (pw.spaceId !== activeSpaceId || !pw.attention) continue
      const key = `${pw.id}:${pw.attention.setAt}`
      rows.push({
        widgetId: pw.id,
        source: 'plugin',
        widgetType: pw.widgetType,
        sourceLabel: pw.widgetType,
        attention: pw.attention,
        unread: !readKeys.has(key),
        taskPath: [],
        sessionName: null,
        worktree: null,
      })
    }

    for (const run of state.runs as Run[]) {
      if (run.spaceId !== activeSpaceId || !run.attention) continue
      const key = `${run.id}:${run.attention.setAt}`
      const taskPath = [run.initiative, run.epic, run.task].filter(s => typeof s === 'string' && s.length > 0)
      rows.push({
        widgetId: run.id,
        source: 'run',
        widgetType: 'run',
        sourceLabel: run.id,
        attention: run.attention,
        unread: !readKeys.has(key),
        taskPath,
        sessionName: run.sessionId ?? null,
        worktree: run.worktree ?? null,
      })
    }

    rows.sort((a, b) => {
      const lvl = LEVEL_ORDER[a.attention.level] - LEVEL_ORDER[b.attention.level]
      if (lvl !== 0) return lvl
      return b.attention.setAt.localeCompare(a.attention.setAt)
    })

    return { rows, unreadCount: rows.filter(r => r.unread).length }
  }, [state.pluginWidgets, state.runs, activeSpaceId])
}
