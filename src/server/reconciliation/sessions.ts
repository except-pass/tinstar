import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { applyPresentationAction, targetExists, type FloorScene, type PresentationAction, type PresentationState } from '../../shared/reconciliationPresentation'
import type { QueueRead } from '../../shared/reconciliationQueue'
import type { CommandResult, ViewCommand } from '../../shared/reconciliationCommands'

export const CONNECTED_MS = 10_000
const RETENTION_MS = 10 * 60_000
import type { RenderedObservation } from '../../shared/presentationObservation'
export type { RenderedObservation } from '../../shared/presentationObservation'
interface Session { session_code: string; designated: boolean; rendered_scene?: RenderedObservation; scene_id: string; key: string; lastSeen: number; state: PresentationState; commands: Map<string, { command: ViewCommand; fingerprint: string; result: CommandResult; created: number }> }
export const secretEquals = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
/** Ephemeral window registry. A delivered command is still queued until the UI
 * acknowledges its committed reducer state. Neither enqueue nor polling applies it. */
export class SceneSessions {
  private sessions = new Map<string, Session>()
  constructor(private clock = Date.now) {}
  private sweep() {
    const now = this.clock()
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > RETENTION_MS) { this.sessions.delete(id); continue }
      for (const [key, row] of session.commands) {
        if (now - row.created > RETENTION_MS) session.commands.delete(key)
        else if (row.result.outcome === 'queued' && now >= row.command.expires_at) row.result = { ...row.result, outcome: 'expired' }
      }
    }
  }
  register(state: PresentationState, rendered_scene?: RenderedObservation) {
    this.sweep()
    if (this.sessions.size >= 64) throw new Error('Window limit reached')
    let session_code: string
    do { session_code = randomBytes(3).toString('hex').toUpperCase() } while ([...this.sessions.values()].some(s => s.session_code === session_code))
    const session: Session = { session_code, designated: false, rendered_scene, scene_id: randomUUID(), key: randomBytes(32).toString('hex'), lastSeen: this.clock(), state, commands: new Map() }
    this.sessions.set(session.scene_id, session)
    return { scene_id: session.scene_id, session_code, designated: session.designated, key: session.key }
  }
  authorized(id: string, key: string) { const session = this.sessions.get(id); return !!session && secretEquals(session.key, key) }
  list() {
    this.sweep()
    return [...this.sessions.values()].map(s => ({ scene_id: s.scene_id, session_code: s.session_code, designated: s.designated, observation: s.rendered_scene ?? null, selection: s.state.selection, connected: this.clock() - s.lastSeen < CONNECTED_MS, last_seen: new Date(s.lastSeen).toISOString(), revision: s.state.revision }))
  }
  read(id: string) {
    this.sweep()
    const session = this.sessions.get(id)
    return session ? { scene_id: id, session_code: session.session_code, designated: session.designated, outcome: this.clock() - session.lastSeen < CONNECTED_MS ? 'connected' : 'disconnected', state: session.state, rendered_scene: session.rendered_scene ?? null, last_seen: new Date(session.lastSeen).toISOString() } : { scene_id: id, outcome: 'unknown-id' }
  }
  designate(id: string) {
    for (const session of this.sessions.values()) session.designated = session.scene_id === id
  }
  resolve(id?: string, code?: string): { scene_id: string } | { outcome: 'ambiguous-session' | 'unknown-id'; message: string } {
    const connected = this.list().filter(s => s.connected)
    if (id) return code && !connected.some(s => s.scene_id === id && s.session_code === code.toUpperCase()) ? { outcome: 'unknown-id', message: 'Session code does not match scene_id.' } : { scene_id: id }
    if (code) {
      const chosen = connected.find(s => s.session_code === code.toUpperCase())
      return chosen ? { scene_id: chosen.scene_id } : { outcome: 'unknown-id', message: 'No connected tab has this code.' }
    }
    if (!connected.length) return { outcome: 'unknown-id', message: 'No connected tab. Open Tin Star and choose Use this tab with ChatGPT.' }
    const chosen = connected.find(s => s.designated) ?? (connected.length === 1 ? connected[0] : undefined)
    return chosen ? { scene_id: chosen.scene_id } : { outcome: 'ambiguous-session', message: 'Choose the code shown in the intended tab or click Use this tab with ChatGPT.' }
  }
  disconnect(id: string) { const s = this.sessions.get(id); if (s) s.lastSeen = this.clock() - CONNECTED_MS }
  sync(id: string, state: PresentationState, acknowledgments: CommandResult[], rendered_scene?: RenderedObservation) {
    this.sweep()
    const session = this.sessions.get(id)!
    session.lastSeen = this.clock()
    if (rendered_scene) session.rendered_scene = rendered_scene
    // A response lost on the wire can be retried; revisions never go backwards.
    if (state.revision >= session.state.revision) session.state = state
    for (const ack of acknowledgments) {
      const row = session.commands.get(ack.command_id)
      if (!row || ack.scene_id !== id) continue
      // A short-lived command can commit before its deadline while its ack is
      // still in flight. Preserve that observed application instead of reporting
      // a false expiry. A late browser may not newly apply an expired command.
      const delayedCommit = row.result.outcome === 'expired' && ack.outcome === 'applied' && typeof ack.applied_at === 'number' && ack.applied_at <= row.command.expires_at && this.clock() <= row.command.expires_at + CONNECTED_MS
      const deliveryUpdate = row.result.outcome === 'applied' && ack.outcome === 'applied' && ack.revision === row.result.revision && ack.applied_at === row.result.applied_at
      if (row.result.outcome !== 'queued' && !delayedCommit && !deliveryUpdate) continue
      // Retried older sync batches must not reopen a finished delivery.
      if (deliveryUpdate && row.result.delivery?.pending === false) continue
      if (!['applied', 'unknown-id', 'stale-revision', 'expired', 'queue-source-unavailable'].includes(ack.outcome)) continue
      if (ack.outcome === 'applied' && (!ack.state || ack.revision !== row.command.expected_revision + 1 || ack.state.revision !== ack.revision || state.revision < ack.revision)) continue
      row.result = { ...ack, scene_id: id }
    }
    return [...session.commands.values()].filter(row => row.result.outcome === 'queued').map(row => row.command).slice(0, 1)
  }
  enqueue(input: { scene_id: string; command_id: string; expected_revision: number; ttl_ms: number; action: PresentationAction }, scene: FloorScene, queue?: QueueRead): CommandResult {
    this.sweep()
    const { scene_id, command_id } = input
    const base = { scene_id, command_id }
    const session = this.sessions.get(scene_id)
    if (!session) return { ...base, outcome: 'unknown-id' }
    const fingerprint = JSON.stringify(input)
    const prior = session.commands.get(command_id)
    if (prior) return prior.fingerprint === fingerprint ? prior.result : { ...base, outcome: 'conflict' }
    if (session.commands.size >= 256) return { ...base, outcome: 'conflict' }
    let outcome: CommandResult['outcome'] = 'queued'
    if (this.clock() - session.lastSeen >= CONNECTED_MS) outcome = 'disconnected'
    else if (input.expected_revision !== session.state.revision) outcome = 'stale-revision'
    else if (input.action.type === 'open-queue' && input.action.cardId && !targetExists(scene, { kind: 'card', id: input.action.cardId })) outcome = 'unknown-id'
    else {
      const check = applyPresentationAction(session.state, { ...input.action, expectedRevision: input.expected_revision }, scene, this.clock(), queue).outcome
      outcome = check === 'applied' ? 'queued' : check
    }
    const command: ViewCommand = { scene_id, command_id, expected_revision: input.expected_revision, action: { ...input.action, origin: 'assistant', expectedRevision: input.expected_revision }, expires_at: this.clock() + input.ttl_ms }
    const result: CommandResult = { ...base, outcome, revision: session.state.revision, ...(outcome === 'queued' ? { delivery: { stage: 'accepted' as const, pending: true } } : {}) }
    session.commands.set(command_id, { command, fingerprint, result, created: this.clock() })
    return result
  }
  result(sceneId: string, commandId: string): CommandResult {
    this.sweep()
    const row = this.sessions.get(sceneId)?.commands.get(commandId)
    return row?.result ?? { scene_id: sceneId, command_id: commandId, outcome: 'unknown-id' }
  }
}
