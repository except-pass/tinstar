import { useSyncExternalStore } from 'react'
import type { SlashCommand, UsageEntry } from '../lib/slashMatching'
import { apiFetch } from '../apiClient'

export interface ServerSlashCommand extends SlashCommand {
  useCount: number
  lastUsedAt: string | null
}

interface State {
  commands: ServerSlashCommand[]
  usage: Record<string, UsageEntry>
  loaded: boolean
}

let state: State = { commands: [], usage: {}, loaded: false }
const listeners = new Set<() => void>()
let inflight = false

function emit() { for (const l of listeners) l() }
function setState(patch: Partial<State>) { state = { ...state, ...patch }; emit() }

async function refresh(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    const res = await apiFetch('/api/slash-commands')
    if (!res.ok) return
    const envelope = (await res.json()) as { ok: boolean; data?: { commands: ServerSlashCommand[] } }
    const commands = envelope.data?.commands ?? []
    const usage: Record<string, UsageEntry> = {}
    for (const c of commands) {
      if (c.lastUsedAt) usage[c.name] = { count: c.useCount, lastUsedAt: c.lastUsedAt }
    }
    setState({ commands, usage, loaded: true })
  } catch {
    // Network error — keep previous data.
  } finally {
    inflight = false
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (!state.loaded) void refresh()
  return () => listeners.delete(l)
}

function getSnapshot(): State { return state }

const refreshStable: () => void = () => void refresh()

export interface UseSlashCommands {
  commands: ServerSlashCommand[]
  usage: Record<string, UsageEntry>
  refresh: () => void
}

export function useSlashCommands(): UseSlashCommands {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { commands: s.commands, usage: s.usage, refresh: refreshStable }
}
