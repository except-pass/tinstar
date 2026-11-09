import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { applyPresentationAction, type FloorScene, type PresentationAction } from './presentation'
import { loadPresentationPreferences, savePresentationPreferences } from './presentationPreferences'
import { retainedQueueItemId, type DeskQueue } from '../shared/reconciliationQueue'
import type { CommandResult, ViewCommand } from '../shared/reconciliationCommands'

/** Clicks and assistant commands synchronously enter the same transition. The
 * acknowledgment is released only by the effect after React commits the view. */
export function usePresentation(scene: FloorScene | null, queue: DeskQueue | null, readFailed = false, active = true, decisionsActive = false, queueReadFailed = false) {
  const [state, setState] = useState(loadPresentationPreferences)
  const [connection, setConnection] = useState<{ scene_id: string } | null>(null)
  const [bridgeError, setBridgeError] = useState(false)
  const readFailure = useRef(readFailed)
  readFailure.current = readFailed
  const decisions = useRef(decisionsActive), queueFailure = useRef(queueReadFailed)
  decisions.current = decisionsActive; queueFailure.current = queueReadFailed
  const current = useRef(state), latestScene = useRef(scene), latestQueue = useRef(queue)
  const pending = useRef<CommandResult[]>([]), ready = useRef<CommandResult[]>([])
  const seen = useRef(new Map<string, CommandResult>())
  latestScene.current = scene
  const previousQueue = useRef(queue)
  latestQueue.current = queue
  const send = useCallback((action: PresentationAction) => {
    if (!latestScene.current) return
    // A Decisions acknowledgment must correspond to a row this view can reveal.
    // The scene reducer still checks the card exists in the underlying source.
    if (decisions.current && (action.type === 'focus' || action.type === 'flash')) {
      const targets = action.type === 'focus' ? [action.target] : action.targets
      if (readFailure.current || queueFailure.current || !latestQueue.current) return { state: current.current, outcome: 'queue-source-unavailable' as const }
      if (targets.some(target => target.kind !== 'card' || !latestQueue.current!.items.some(item => item.cardIds.includes(target.id)))) return { state: current.current, outcome: 'unknown-id' as const }
    }
    const applied = applyPresentationAction(current.current, action, latestScene.current, Date.now(), latestQueue.current)
    current.current = applied.state
    setState(applied.state)
    return applied
  }, [])
  useEffect(() => {
    current.current = state
    savePresentationPreferences(state)
    ready.current.push(...pending.current.filter(ack => (ack.revision ?? 0) <= state.revision).map(ack => ({ ...ack, applied_at: Date.now() })))
    pending.current = pending.current.filter(ack => (ack.revision ?? 0) > state.revision)
  }, [state])
  useEffect(() => {
    if (queue) {
      const queueItemId = retainedQueueItemId(previousQueue.current, queue, current.current.queueItemId ?? null)
      if (queueItemId !== current.current.queueItemId) {
        const next = { ...current.current, queueItemId, revision: current.current.revision + 1 }
        current.current = next
        setState(next)
      }
      previousQueue.current = queue
    }
  }, [queue])
  useEffect(() => {
    if (!active) {
      // A later Overview registration has a new scene identity. Never replay
      // acknowledgments for the view that was hidden by manual navigation.
      pending.current = []; ready.current = []; seen.current.clear()
      setConnection(null)
      return
    }
    let stopped = false, timer: ReturnType<typeof setTimeout>
    let credentials: { scene_id: string; key: string } | null = null
    let controller: AbortController | null = null
    async function post(payload: unknown, keepalive = false) {
      const requestController = new AbortController()
      controller = requestController
      const timeout = setTimeout(() => requestController.abort(), 5000)
      try {
        const res = await apiFetch('/api/reconciliation/ui', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify(payload), signal: requestController.signal, keepalive })
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json()
        if (!body.ok) throw new Error('UI sync unavailable')
        return body.data
      } finally { clearTimeout(timeout) }
    }
    function receive(command: ViewCommand) {
      if (!credentials || command.scene_id !== credentials.scene_id) return
      const previous = seen.current.get(command.command_id)
      if (previous) { ready.current.push(previous); return }
      const applied = Date.now() >= command.expires_at ? { outcome: 'expired' as const, state: current.current } : send(command.action)
      if (!applied) return
      const ack: CommandResult = { scene_id: credentials.scene_id, command_id: command.command_id, outcome: applied.outcome, revision: applied.state.revision, state: applied.state }
      // Bound dedup memory; server retries are limited to ten minutes.
      if (seen.current.size >= 256) seen.current.delete(seen.current.keys().next().value!)
      seen.current.set(command.command_id, ack)
      if (applied.outcome === 'applied') pending.current.push(ack)
      else ready.current.push(ack)
    }
    async function tick() {
      const batch = ready.current.splice(0, 32)
      try {
        if (!credentials) {
          credentials = await post({ type: 'register', state: current.current, rendered_scene: { scene_generated_at: latestScene.current?.generatedAt ?? null, scene_read_failed: readFailure.current } })
          if (stopped) { if (credentials) void post({ type: 'disconnect', ...credentials }, true).catch(() => {}); return }
          setConnection({ scene_id: credentials!.scene_id }); setBridgeError(false)
        } else {
          const data = await post({ type: 'sync', ...credentials, state: current.current, acknowledgments: batch, rendered_scene: { scene_generated_at: latestScene.current?.generatedAt ?? null, scene_read_failed: readFailure.current } })
          if (!stopped) { setBridgeError(false); for (const command of data.commands as ViewCommand[]) receive(command) }
        }
      } catch (error) {
        ready.current.unshift(...batch)
        if (!stopped) setBridgeError(true)
        // Server restarts discard window identities; a denied old key is never
        // reused. Other failures retain it and retry with bounded polling.
        if (error instanceof Error && error.message === '403') { credentials = null; seen.current.clear() }
      } finally { if (!stopped) timer = setTimeout(() => void tick(), 1000) }
    }
    const disconnect = () => {
      if (credentials) void post({ type: 'disconnect', ...credentials }, true).catch(() => {})
    }
    void tick()
    window.addEventListener('pagehide', disconnect)
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); window.removeEventListener('pagehide', disconnect); disconnect() }
  }, [send, active])
  return { state, send, connection, bridgeError }
}
