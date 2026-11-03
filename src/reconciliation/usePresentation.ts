import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { applyPresentationAction, initialPresentation, type FloorScene, type PresentationAction } from './presentation'
import type { CommandResult, ViewCommand } from '../shared/reconciliationCommands'

/** Clicks and assistant commands synchronously enter the same transition. The
 * acknowledgment is released only by the effect after React commits the view. */
export function usePresentation(scene: FloorScene | null) {
  const [state, setState] = useState(initialPresentation)
  const [connection, setConnection] = useState<{ scene_id: string } | null>(null)
  const [bridgeError, setBridgeError] = useState(false)
  const current = useRef(state), latestScene = useRef(scene)
  const pending = useRef<CommandResult[]>([]), ready = useRef<CommandResult[]>([])
  const seen = useRef(new Map<string, CommandResult>())
  latestScene.current = scene
  const send = useCallback((action: PresentationAction) => {
    if (!latestScene.current) return
    const applied = applyPresentationAction(current.current, action, latestScene.current)
    current.current = applied.state
    setState(applied.state)
    return applied
  }, [])
  useEffect(() => {
    current.current = state
    ready.current.push(...pending.current.filter(ack => (ack.revision ?? 0) <= state.revision))
    pending.current = pending.current.filter(ack => (ack.revision ?? 0) > state.revision)
  }, [state])
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    let credentials: { scene_id: string; key: string } | null = null
    let controller: AbortController | null = null
    async function post(payload: unknown, keepalive = false) {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 5000)
      try {
        const res = await apiFetch('/api/reconciliation/ui', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify(payload), signal: controller.signal, keepalive })
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
          credentials = await post({ type: 'register', state: current.current })
          if (stopped) { if (credentials) void post({ type: 'disconnect', ...credentials }, true).catch(() => {}); return }
          setConnection({ scene_id: credentials!.scene_id }); setBridgeError(false)
        } else {
          const data = await post({ type: 'sync', ...credentials, state: current.current, acknowledgments: batch })
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
  }, [send])
  return { state, send, connection, bridgeError }
}
