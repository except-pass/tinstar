import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { applyPresentationAction, type FloorScene, type PresentationAction } from './presentation'
import { loadPresentationPreferences, savePresentationPreferences } from './presentationPreferences'
import { retainedQueueItemId, type DeskQueue } from '../shared/reconciliationQueue'
import { presentationTargets, type RenderedObservation } from '../shared/presentationObservation'
import { semanticId } from './presentation'
import { observeTargets, revealTargets } from './presentationVisibility'
import type { CommandResult, ViewCommand } from '../shared/reconciliationCommands'

/** Clicks and assistant commands synchronously enter the same transition. The
 * acknowledgment is released only by the effect after React commits the view. */
export function usePresentation(scene: FloorScene | null, queue: DeskQueue | null, readFailed = false, active = true, decisionsActive = false, queueReadFailed = false, onAssistantPresent?: (action: PresentationAction) => void) {
  const [state, setState] = useState(loadPresentationPreferences)
  const [connection, setConnection] = useState<{ scene_id: string; session_code: string; designated: boolean } | null>(null)
  const [pendingFocus, setPendingFocus] = useState(false)
  const designate = useRef<() => Promise<void>>(async () => {})
  const useThisTab = useCallback(() => designate.current(), [])
  const assistantPresent = useRef(onAssistantPresent)
  const navigate = assistantPresent
  assistantPresent.current = onAssistantPresent
  const surface = useRef<'overview' | 'decisions' | 'other'>('overview')
  surface.current = !active ? 'other' : decisionsActive ? 'decisions' : 'overview'
  const committed = useRef<{ rendered_at: string | null; revision: number }>({ rendered_at: null, revision: 0 })
  const visual = useRef<{ ack: CommandResult; targets: string[]; needsReplay: boolean } | null>(null)
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
    if (action.origin !== 'assistant' && visual.current) {
      const ack = { ...visual.current.ack, delivery: { ...visual.current.ack.delivery!, stage: 'not-visible' as const, reason: 'Superseded by user interaction.', pending: false } }
      ready.current.push(ack); seen.current.set(ack.command_id, ack); visual.current = null; setPendingFocus(false)
    }
    // A Decisions acknowledgment must correspond to a row this view can reveal.
    // The scene reducer still checks the card exists in the underlying source.
    if (decisions.current && (action.type === 'focus' || action.type === 'flash')) {
      const targets = action.type === 'focus' ? [action.target] : action.targets
      if (readFailure.current || queueFailure.current || !latestQueue.current) return { state: current.current, outcome: 'queue-source-unavailable' as const }
      if (action.origin !== 'assistant' && targets.some(target => target.kind !== 'card' || !(latestQueue.current!.needsWill ?? latestQueue.current!.items).some(item => item.cardIds.includes(target.id)))) return { state: current.current, outcome: 'unknown-id' as const }
    }
    const applied = applyPresentationAction(current.current, action, latestScene.current, Date.now(), latestQueue.current)
    current.current = applied.state
    setState(applied.state)
    // Manual and MCP navigation must reveal the same surface before the ack.
    // Repeated commands also reopen a previously browsed canonical item.
    if (action.origin !== 'assistant' && applied.outcome === 'applied' && ['open-queue', 'navigate-queue', 'navigate-card', 'reveal-search'].includes(action.type)) navigate.current?.(action)
    return applied
  }, [])
  useEffect(() => {
    current.current = state
    savePresentationPreferences(state)
    committed.current = { rendered_at: new Date().toISOString(), revision: state.revision }
    ready.current.push(...pending.current.filter(ack => (ack.revision ?? 0) <= state.revision).map(ack => {
      const committedAck = { ...ack, applied_at: ack.applied_at ?? Date.now(), delivery: ack.delivery?.targets?.length ? ack.delivery : { stage: 'rendered' as const, pending: false } }
      seen.current.set(ack.command_id, committedAck)
      if (visual.current?.ack.command_id === ack.command_id) visual.current.ack = committedAck
      return committedAck
    }))
    pending.current = pending.current.filter(ack => (ack.revision ?? 0) > state.revision)
  }, [state, scene, active, decisionsActive])
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
    let credentials: { scene_id: string; session_code: string; designated: boolean; key: string } | null = null
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
      if (applied.outcome === 'applied') {
        if (visual.current) {
          const previous = visual.current.ack
          const superseded = { ...previous, delivery: { ...previous.delivery!, stage: 'not-visible' as const, reason: 'Superseded by a newer assistant command.', pending: false } }
          ready.current.push(superseded); seen.current.set(previous.command_id, superseded)
          visual.current = null; setPendingFocus(false)
        }
        const targets = presentationTargets(command.action).map(semanticId)
        ack.delivery = { stage: 'applied-to-state', targets, pending: targets.length > 0 }
        pending.current.push(ack)
        if (targets.length) {
          visual.current = { ack, targets, needsReplay: document.visibilityState !== 'visible' || !document.hasFocus() }
          setPendingFocus(true)
        }
        assistantPresent.current?.(command.action)
      }
      else ready.current.push(ack)
    }
    function observation(): RenderedObservation {
      return { scene_generated_at: latestScene.current?.generatedAt ?? null, scene_read_failed: readFailure.current,
        ...committed.current, surface: surface.current, route: (location.pathname + location.search).slice(0, 2048), title: document.title.slice(0, 256),
        visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden', focused: document.hasFocus(),
        selection: current.current.selection ? semanticId(current.current.selection) : null, pending_command: visual.current?.ack.command_id ?? null }
    }
    function inspect() {
      const waiting = visual.current
      if (!waiting || committed.current.revision < (waiting.ack.revision ?? 0)) return
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        if (waiting.needsReplay) {
          // Replay the visual effect, not the semantic command/revision. User
          // input cancels this pending delivery before it can steal focus.
          waiting.needsReplay = false
          const next = { ...current.current, flash: { ids: waiting.targets, until: Date.now() + 4000, revealTargets: true } }
          current.current = next; setState(next)
          // Wait for this replay to commit before claiming visual delivery.
          return
        }
        revealTargets(waiting.targets, surface.current)
      } else waiting.needsReplay = true
      const delivery = observeTargets(waiting.targets, surface.current)
      const ack = { ...waiting.ack, delivery }
      waiting.ack = ack; seen.current.set(ack.command_id, ack)
      ready.current.push(ack)
      if (!delivery.pending) { visual.current = null; setPendingFocus(false) }
    }
    async function tick() {
      inspect()
      const batch = ready.current.splice(0, 1)
      try {
        if (!credentials) {
          credentials = await post({ type: 'register', state: current.current, rendered_scene: observation() })
          if (stopped) { if (credentials) void post({ type: 'disconnect', scene_id: credentials.scene_id, key: credentials.key }, true).catch(() => {}); return }
          setConnection({ scene_id: credentials!.scene_id, session_code: credentials!.session_code, designated: credentials!.designated });
          designate.current = async () => {
            if (!credentials || stopped) return
            await post({ type: 'designate', scene_id: credentials.scene_id, key: credentials.key })
            setConnection(previous => previous ? { ...previous, designated: true } : previous)
          }; setBridgeError(false)
        } else {
          const data = await post({ type: 'sync', scene_id: credentials.scene_id, key: credentials.key, state: current.current, acknowledgments: batch, rendered_scene: observation() })
          if (!stopped) { setBridgeError(false); setConnection(previous => previous && previous.designated !== data.designated ? { ...previous, designated: data.designated } : previous); for (const command of data.commands as ViewCommand[]) receive(command) }
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
      if (credentials) void post({ type: 'disconnect', scene_id: credentials.scene_id, key: credentials.key }, true).catch(() => {})
    }
    void tick()
    const foreground = () => { inspect() }
    const takeOwnership = () => {
      const waiting = visual.current
      if (!waiting) return
      const ack = { ...waiting.ack, delivery: { ...waiting.ack.delivery!, stage: 'not-visible' as const, reason: 'Superseded by user interaction.', pending: false } }
      ready.current.push(ack); seen.current.set(ack.command_id, ack)
      visual.current = null; setPendingFocus(false)
    }
    const inputEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const event of inputEvents) document.addEventListener(event, takeOwnership, true)
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    window.addEventListener('pagehide', disconnect)
    return () => { for (const event of inputEvents) document.removeEventListener(event, takeOwnership, true); stopped = true; clearTimeout(timer); controller?.abort(); window.removeEventListener('pagehide', disconnect); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); visual.current = null; disconnect() }
  }, [send, active])
  return { state, send, connection, bridgeError, useThisTab, pendingFocus }
}
