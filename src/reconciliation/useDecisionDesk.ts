import { useCallback, useEffect, useRef, useState } from 'react'
import { deskCall, type DeskClaim, type DeskPacket, type DeskPolicy, type DeskResult, type DeskSession, type DeskSnapshot, type DeskSubmit } from './decisionDeskClient'

const storageKey = 'tinstar-decision-review-v1'
interface ReviewContext {
  create: string; token?: string; id?: string; claimOperation?: string; lease?: string; recoveryLease?: string
  selections: Record<string, string>; attempts: Record<string, DeskSubmit>; release?: { operation_id: string; action: 'skip' | 'research'; reason: string; review_session_token?: string; lease_token?: string }
}
const fresh = (): ReviewContext => ({ create: crypto.randomUUID(), selections: {}, attempts: {} })
function load(): ReviewContext {
  try { return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? fresh() } catch { return fresh() }
}
const requestKey = (packet: DeskPacket) => `${packet.packet.binding.card_id}:${packet.packet.binding.request_id}`
export interface DecisionTarget { id: string; cardId?: string; requestKey?: string; packetId?: string }
export function useDecisionDesk(target?: DecisionTarget, onTargetConsumed?: (id: string) => void) {
  const targetRef = useRef(target), consumed = useRef(onTargetConsumed), handledTarget = useRef<string>()
  targetRef.current = target; consumed.current = onTargetConsumed
  const [lastTarget, setLastTarget] = useState<DecisionTarget>(), [targetBlocked, setTargetBlocked] = useState(false)
  const context = useRef<ReviewContext>(load())
  const lock = useRef(false), mounted = useRef(true)
  const visibleMeasure = useRef<{ name: string; started: number } | null>(null)
  const [claim, setClaim] = useState<DeskClaim | null>(null), claimRef = useRef(claim)
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null)
  const [policy, setPolicy] = useState<DeskPolicy | null>(null)
  const [sessions, setSessions] = useState<DeskSession[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DeskResult | null>(null)
  const [notice, setNotice] = useState(''), [revision, setRevision] = useState(0)
  const [submissionRevision, setSubmissionRevision] = useState(0)
  const persist = useCallback(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(context.current)) } catch { /* Memory still retains exact capabilities and retry IDs. */ }
    setRevision(value => value + 1)
  }, [])
  const accept = useCallback((value: DeskClaim) => {
    claimRef.current = value; setClaim(value)
    context.current.lease = value.lease_token
    context.current.claimOperation = undefined
    persist()
  }, [persist])
  useEffect(() => {
    const measure = visibleMeasure.current
    if (!measure) return
    const frame = requestAnimationFrame(() => {
      performance.measure(measure.name, { start: measure.started, end: performance.now() })
      if (visibleMeasure.current === measure) visibleMeasure.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [claim])
  const refresh = useCallback(async () => {
    const values = await Promise.allSettled([
      deskCall<DeskSnapshot>('snapshot'), deskCall<DeskPolicy>('policy'),
      deskCall<{ sessions: DeskSession[] }>('sessions'),
    ])
    if (!mounted.current) return
    if (values[0].status === 'fulfilled' && values[0].value?.counts && Array.isArray(values[0].value.ready)) setSnapshot(values[0].value)
    else setSnapshot(null)
    if (values[1].status === 'fulfilled' && values[1].value?.values) setPolicy(values[1].value)
    else setPolicy(null)
    if (values[2].status === 'fulfilled' && Array.isArray(values[2].value?.sessions)) setSessions(values[2].value.sessions)
  }, [])
  // History arrives progressively. This read only updates the desk projection;
  // it does not claim cards or disturb an answer being edited.
  useEffect(() => {
    let active = true, pending = false
    const timer = setInterval(() => {
      if (document.hidden || pending) return
      pending = true
      void deskCall<DeskSnapshot>('snapshot').then(value => { if (active) setSnapshot(value) }).catch(() => {}).finally(() => { pending = false })
    }, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const ensureSession = useCallback(async () => {
    if (context.current.token) {
      const { sessions: valid } = await deskCall<{ sessions: DeskSession[] }>('sessions')
      if (valid.some(session => session.id === context.current.id && Date.parse(session.expires_at) > Date.now())) return
      context.current.recoveryLease = Object.values(context.current.attempts)[0]?.lease_token ?? context.current.lease ?? context.current.recoveryLease
      context.current.token = undefined; context.current.id = undefined; context.current.lease = undefined
      context.current.claimOperation = undefined
      context.current.create = crypto.randomUUID()
    }
    persist()
    const response = await deskCall<{ session: DeskSession; review_session_token: string }>('sessions', {
      operation_id: context.current.create, label: 'Browser review', device: matchMedia('(max-width:660px)').matches ? 'phone' : 'desktop',
    })
    if (!response.review_session_token || !response.session?.id) throw new Error('Review session could not be verified. Backend unavailable.')
    context.current.token = response.review_session_token; context.current.id = response.session.id; persist()
  }, [persist])
  const recover = useCallback(async (pending?: DeskSubmit) => {
    type Recovery = { submissions: Array<{ operation_id: string; selection: DeskResult['selection']; state: string; next: DeskSubmit['next']; resolve_wait?: string; binding_matches_original_lease?: boolean }> }
    const capabilities = [...new Set([pending?.lease_token ?? context.current.recoveryLease ?? context.current.lease, pending?.original_lease_token].filter((value): value is string => !!value))]
    let recovered: Recovery = { submissions: [] }
    for (const capability of capabilities.length ? capabilities : [undefined]) {
      const value = await deskCall<Recovery>('submission-state', { review_session_token: context.current.token, ...(capability ? { original_lease_token: capability } : {}) })
      recovered = { submissions: [...recovered.submissions.filter(old => !value.submissions.some(row => row.operation_id === old.operation_id)), ...value.submissions] }
      if (pending && value.submissions.some(row => row.operation_id === pending.operation_id && row.binding_matches_original_lease)) {
        pending.original_lease_token = capability; persist(); break
      }
    }
    return recovered
  }, [persist])
  const reconcileRelease = useCallback(async () => {
    const pending = context.current.release
    if (!pending) return
    pending.review_session_token ??= context.current.token
    pending.lease_token ??= context.current.lease
    persist()
    const response = await deskCall<{ outcome: string; next?: DeskClaim; code?: string; message?: string }>('release', pending)
    if (!response.next && response.code && ['claim-lost', 'card-held', 'source-write-pending'].includes(response.code)) {
      context.current.release = undefined
      if (response.code !== 'source-write-pending') {
        context.current.lease = undefined
        accept({ ...claimRef.current, outcome: 'lease-lost', code: response.code, lease_token: undefined, lease: undefined, message: response.message } as DeskClaim)
      }
      persist()
      throw new Error(response.message ?? 'Lease expired or lost. Re-claim and revalidate before writing. Your selection is retained.')
    }
    if (!response.next) throw new Error(response.message ?? 'Release not confirmed. Current card retained.')
    context.current.release = undefined
    context.current.selections = {}; context.current.attempts = {}
    setTargetBlocked(false); setResult(null); setNotice(pending.action === 'skip' ? 'Skipped without an answer.' : 'Research requested without an answer.')
    accept(response.next)
    return response.next
  }, [accept, persist])
  const claimNext = useCallback(async (cardId?: string, revalidate = false, exactRequestKey?: string, exactPacketId?: string) => {
    const released = await reconcileRelease()
    if (released) return released
    if (!cardId) setTargetBlocked(false)
    await ensureSession()
    const pending = Object.values(context.current.attempts)[0]
    if (pending) {
      if (pending.original_lease_token) await recover(pending)
      const packet = claimRef.current?.packet ?? await deskCall<DeskPacket>(`packet?id=${encodeURIComponent(pending.packet_id)}`)
      if (!claimRef.current?.packet) accept({ outcome: 'lease-lost', packet, lease_token: pending.lease_token })
      if (exactRequestKey && exactRequestKey !== packet.packet.binding.request_key) throw new Error('Resolve the retained answer before returning to another source request.')
      cardId = packet.packet.binding.card_id
      exactRequestKey = packet.packet.binding.request_key
    }
    context.current.claimOperation ??= crypto.randomUUID(); persist()
    const started = performance.now()
    const value = await deskCall<DeskClaim>('claim', { operation_id: context.current.claimOperation,
      review_session_token: context.current.token, ...(context.current.lease && !revalidate ? { lease_token: context.current.lease } : {}), ...(cardId ? { card_id: cardId } : {}),
    })
    if (!value?.outcome) throw new Error('Prepared claim could not be verified. Backend unavailable.')
    const retainedClaim = value.outcome === 'held' || value.outcome === 'already-holding' || !!value.lease_token && value.lease_token === context.current.lease
    const mismatchedRequest = !!value.packet && !!(cardId && value.packet.packet.binding.card_id !== cardId || exactRequestKey && value.packet.packet.binding.request_key !== exactRequestKey || exactPacketId && value.packet.id !== exactPacketId)
    if (!pending && !retainedClaim && value.packet && mismatchedRequest) {
      const refused: DeskClaim = { outcome: 'requested-unavailable', message: 'The requested decision is not ready or is held. No substitute decision is shown.', lease_token: value.lease_token }
      const operation = `return-release:${context.current.claimOperation}`
      accept(refused)
      if (value.lease_token) {
        const released = await deskCall<{ outcome: string }>('release', { operation_id: operation, action: 'release', reason: 'Claim did not match the requested source decision', review_session_token: context.current.token, lease_token: value.lease_token })
        if (released.outcome !== 'released') throw new Error('The unintended claim release could not be confirmed. No substitute decision is shown.')
        refused.lease_token = undefined; accept(refused)
      }
      return refused
    }
    if (value.outcome === 'already-holding' || retainedClaim && mismatchedRequest) setNotice('This session already holds a different decision. Finish or skip it before switching.')
    visibleMeasure.current = { name: `decision-desk.claim-visible.${value.outcome}`, started }
    if (pending && value.packet && claimRef.current?.packet && requestKey(value.packet) !== requestKey(claimRef.current.packet)) {
      accept({ ...claimRef.current, outcome: 'lease-lost', message: 'Retained answer must be resolved before reviewing another request.' })
    } else if (!value.packet && claimRef.current?.packet && (value.code === 'claim-lost' || value.code === 'card-held' || value.code === 'source-write-pending' || Object.keys(context.current.attempts).length > 0)) {
      accept({ ...claimRef.current, outcome: value.code === 'card-held' ? 'card-held' : 'lease-lost', code: value.code, message: value.message })
    } else accept(value)
    performance.measure(`decision-desk.claim-api.${value.outcome}`, { start: started, end: performance.now() })
    return value
  }, [accept, ensureSession, persist, recover, reconcileRelease])
  const claimTarget = useCallback(async (intent: DecisionTarget) => {
    handledTarget.current = intent.id
    setLastTarget(intent)
    setTargetBlocked(true)
    try {
      const response = intent.cardId ? await claimNext(intent.cardId, false, intent.requestKey, intent.packetId) : { outcome: 'requested-unavailable', message: 'The exact source request and canonical card binding are not available in the current source observation. No substitute decision was claimed.' }
      if (!intent.cardId) {
        if (!claimRef.current?.packet) accept(response)
        else setNotice(response.message ?? 'The requested source is not ready. Your held decision is retained.')
      }
      const packet = response.packet
      setTargetBlocked(!packet || packet.packet.binding.card_id !== intent.cardId || !!intent.requestKey && packet.packet.binding.request_key !== intent.requestKey || !!intent.packetId && packet.id !== intent.packetId || response.outcome === 'packet-invalidated' || !packet.validation.valid)
      return response
    } finally {
      // Consume even when refusing a substitute needs release recovery. An
      // explicit retry can target again; refresh must never re-arm navigation.
      consumed.current?.(intent.id)
    }
  }, [accept, claimNext])
  const run = useCallback(async (action: () => Promise<void>, ambiguous = false) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { await action() } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : 'Decision Desk backend unavailable')
        if (ambiguous) setResult({ outcome: 'save-unconfirmed', operation_id: '', selection: { packet_id: '', packet_version: 0, request_id: '', option_id: '' }, message: 'Save status unconfirmed — confirming result. Your selection is retained. Retry the same operation ID.' })
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false); await refresh() }
  }, [refresh])
  useEffect(() => {
    mounted.current = true
    void run(async () => {
      if (await reconcileRelease()) return
      await ensureSession()
      // Server recovery is authoritative after reload. Never generate a new
      // operation for an unresolved answer whose first response was lost.
      const pending = Object.values(context.current.attempts)[0]
      const recoveryLease = pending?.lease_token ?? context.current.recoveryLease ?? context.current.lease
      if (pending) {
        const packet = await deskCall<DeskPacket>(`packet?id=${encodeURIComponent(pending.packet_id)}`)
        accept({ outcome: 'lease-lost', packet, lease_token: pending.lease_token })
      }
      const recovered = await recover(pending)
      const retained = pending ? recovered.submissions.find(attempt => attempt.operation_id === pending.operation_id) : recovered.submissions[0]
      if (!pending && retained && recoveryLease) {
        const packet = await deskCall<DeskPacket>(`packet?id=${encodeURIComponent(retained.selection.packet_id)}`)
        accept({ outcome: 'lease-lost', packet, lease_token: recoveryLease })
      }
      const intent = targetRef.current
      const response = intent && handledTarget.current !== intent.id ? await claimTarget(intent) : await claimNext(undefined, true)
      const held = response.packet ? response : claimRef.current
      for (const attempt of recovered.submissions) {
        if (held?.lease_token && held.packet && attempt.selection.request_id === held.packet.packet.binding.request_id) {
          const key = requestKey(held.packet)
          // A definite invalidation authorized no write. Fresh research must
          // not inherit that abandoned operation or silently select its answer.
          if (attempt.state === 'packet-invalidated' && attempt.selection.packet_id !== held.packet.id) {
            if (context.current.attempts[key]?.operation_id === attempt.operation_id) { delete context.current.attempts[key]; delete context.current.selections[key] }
            continue
          }
          context.current.selections[key] = attempt.selection.option_id
          context.current.attempts[key] ??= { ...attempt.selection, operation_id: attempt.operation_id, lease_token: recoveryLease ?? held.lease_token,
            review_session_token: context.current.token, next: attempt.next, ...(attempt.resolve_wait ? { resolve_wait: attempt.resolve_wait } : {}) }
          setResult({ outcome: attempt.state, operation_id: attempt.operation_id, selection: attempt.selection, message: 'Retained answer recovered. Retry the same operation without advancing.' })
        }
      }
      persist()
    })
    return () => { mounted.current = false }
  }, [accept, claimNext, claimTarget, ensureSession, persist, recover, reconcileRelease, run])
  useEffect(() => {
    if (target && handledTarget.current !== target.id && context.current.id && !busy) void run(async () => { await claimTarget(target) })
  }, [target, busy, claimTarget, run])
  // Cached-source revalidation, never research. Visibility/focus avoid an
  // unattended polling loop; the lease expiry is also enforced locally.
  useEffect(() => {
    const check = () => { if (!document.hidden && !lock.current && !(claimRef.current?.packet && context.current.attempts[requestKey(claimRef.current.packet)])) void run(async () => { await claimNext(undefined, true) }) }
    window.addEventListener('focus', check)
    const timer = setInterval(check, 30_000)
    return () => { window.removeEventListener('focus', check); clearInterval(timer) }
  }, [claimNext, run])
  const select = (packet: DeskPacket, option: string) => {
    if (context.current.attempts[requestKey(packet)]) return
    context.current.selections[requestKey(packet)] = option; persist()
  }
  const submit = (confirmed = false) => run(async () => {
    if (await reconcileRelease()) return
    await ensureSession()
    if (!context.current.lease && claimRef.current?.packet && !context.current.attempts[requestKey(claimRef.current.packet)]) {
      await claimNext(undefined, true)
    }
    const current = claimRef.current, packet = current?.packet
    if (!packet || !current?.lease_token) throw new Error('Re-claim and revalidate before submitting.')
    const key = requestKey(packet), option = context.current.selections[key]
    if (!option) throw new Error('Choose a source option before submitting.')
    const started = performance.now()
    const input = context.current.attempts[key] ?? {
      operation_id: crypto.randomUUID(), review_session_token: context.current.token, lease_token: current.lease_token,
      packet_id: packet.id, packet_version: packet.version, request_id: packet.packet.binding.request_id, option_id: option,
      next: { owner: packet.packet.authorization.next_owner, status: packet.packet.authorization.next_status },
    }
    if (confirmed && (packet.packet.risk.rating === 'High' || packet.packet.reversibility.rating === 'Difficult')) input.confirmation = { option_id: option, scope: packet.packet.authorization.scope }
    context.current.attempts[key] = input; context.current.recoveryLease = input.lease_token; persist()
    const saved = await deskCall<DeskResult>('submit', input)
    setResult(saved)
    if (saved.outcome === 'recorded' || saved.outcome === 'recorded-empty') {
      setTargetBlocked(false); setSubmissionRevision(value => value + 1)
      delete context.current.attempts[key]; delete context.current.selections[key]; context.current.recoveryLease = undefined; persist()
      visibleMeasure.current = { name: `decision-desk.submit-visible.${saved.next?.outcome ?? 'unavailable'}`, started }
      accept(saved.next ?? { outcome: 'next-unavailable' })
      setNotice(saved.next?.packet ? 'Decision recorded. Next decision loaded. Recorded; awaiting worker acknowledgment.' : 'Decision recorded. Recorded; awaiting worker acknowledgment.')
      performance.measure(`decision-desk.submit-to-next.${saved.next?.outcome ?? 'unavailable'}`, { start: started, end: performance.now() })
    }
  }, true)
  const release = (action: 'skip' | 'research', reason = '') => run(async () => {
    if (await reconcileRelease()) return
    await ensureSession()
    if (!context.current.lease) { await claimNext(undefined, true); return }
    context.current.release = { operation_id: crypto.randomUUID(), action, reason: reason.trim() || (action === 'skip' ? 'Reviewer skipped without an answer' : 'Reviewer requested more research'), review_session_token: context.current.token, lease_token: context.current.lease }
    persist()
    await reconcileRelease()
  })
  return { claim, parts: claim?.packet ? [claim.packet] : [], snapshot, policy, sessions, busy, error, result, notice, revision, submissionRevision,
    lastTarget, targetBlocked, currentSession: context.current.id, selections: context.current.selections, attempts: context.current.attempts,
    select, submit, release, refresh, retryClaim: () => run(async () => {
      setNotice('')
      const held = await claimNext(undefined, true)
      if (held.packet && held.lease_token) {
        const attempt = context.current.attempts[requestKey(held.packet)]
        if (attempt && (attempt.lease_token !== held.lease_token || attempt.packet_id !== held.packet.id)) {
          attempt.original_lease_token ??= attempt.lease_token; attempt.review_session_token = context.current.token; attempt.lease_token = held.lease_token
          attempt.packet_id = held.packet.id; attempt.packet_version = held.packet.version; context.current.recoveryLease = attempt.lease_token; persist()
        }
        if (held.outcome !== 'packet-invalidated') setResult(null)
      }
    }),
    claimAvailable: () => run(async () => { setTargetBlocked(false); setNotice(''); await claimNext(undefined, true) }),
    retryTarget: (cardId?: string) => run(async () => { if (lastTarget) await claimTarget({ ...lastTarget, cardId: cardId ?? lastTarget.cardId }) }),
    claimCard: (card: string, exactRequestKey?: string, exactPacketId?: string) => run(async () => { await claimTarget({ id: crypto.randomUUID(), cardId: card, requestKey: exactRequestKey, packetId: exactPacketId }) }),
    newSession: () => run(async () => {
      if (context.current.release || context.current.lease || Object.keys(context.current.attempts).length) throw new Error('Finish or skip this session’s held decision before creating another here. Other browser contexts can create independent sessions.')
      context.current = fresh(); persist(); await claimNext()
    }),
    prepareNow: (cardId: string, requestId: string) => run(async () => {
      const prepared = await deskCall<{ outcome: string; explanation: string }>('prepare', { card_id: cardId, request_id: requestId, reason: 'Prepare this decision now' })
      setNotice(prepared.explanation)
    }),
    savePolicy: async (values: DeskPolicy['values']) => {
      if (!policy) throw new Error('Effective policy unavailable')
      try {
        const saved = await deskCall<DeskPolicy>('policy', { expected_version: policy.version, values }, 'PUT'); setPolicy(saved); await refresh(); return saved
      } catch (error) { await refresh(); throw error }
    },
  }
}
export type DecisionDeskState = ReturnType<typeof useDecisionDesk>
export { requestKey }
