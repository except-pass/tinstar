import { useCallback, useEffect, useRef, useState } from 'react'
import { deskCall, type DeskClaim, type DeskPacket, type DeskPolicy, type DeskResult, type DeskSession, type DeskSnapshot, type DeskSubmit } from './decisionDeskClient'

const storageKey = 'tinstar-decision-review-v1'
interface ReviewContext {
  create: string; token?: string; id?: string; claimOperation?: string; lease?: string
  selections: Record<string, string>; attempts: Record<string, DeskSubmit>; release?: { operation_id: string; action: 'skip' | 'research'; reason: string }
}
const fresh = (): ReviewContext => ({ create: crypto.randomUUID(), selections: {}, attempts: {} })
function load(): ReviewContext {
  try { return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? fresh() } catch { return fresh() }
}
const requestKey = (packet: DeskPacket) => `${packet.packet.binding.card_id}:${packet.packet.binding.request_id}`
export function useDecisionDesk(initialCard?: string, targetPending = false) {
  const initialTarget = useRef(initialCard)
  initialTarget.current = initialCard
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
  const ensureSession = useCallback(async () => {
    if (context.current.token) return
    persist()
    const response = await deskCall<{ session: DeskSession; review_session_token: string }>('sessions', {
      operation_id: context.current.create, label: 'Browser review', device: matchMedia('(max-width:660px)').matches ? 'phone' : 'desktop',
    })
    if (!response.review_session_token || !response.session?.id) throw new Error('Review session could not be verified. Backend unavailable.')
    context.current.token = response.review_session_token; context.current.id = response.session.id; persist()
  }, [persist])
  const claimNext = useCallback(async (cardId?: string, revalidate = false) => {
    await ensureSession()
    context.current.claimOperation ??= crypto.randomUUID(); persist()
    const started = performance.now()
    const value = await deskCall<DeskClaim>('claim', { operation_id: context.current.claimOperation,
      review_session_token: context.current.token, ...(context.current.lease && !revalidate ? { lease_token: context.current.lease } : {}), ...(cardId ? { card_id: cardId } : {}),
    })
    if (!value?.outcome) throw new Error('Prepared claim could not be verified. Backend unavailable.')
    if (value.outcome === 'already-holding') setNotice('This session already holds a different decision. Finish or skip it before switching.')
    visibleMeasure.current = { name: `decision-desk.claim-visible.${value.outcome}`, started }
    if (!value.packet && claimRef.current?.packet && (value.code === 'claim-lost' || value.code === 'card-held' || value.code === 'source-write-pending' || Object.keys(context.current.attempts).length > 0)) {
      accept({ ...claimRef.current, outcome: value.code === 'card-held' ? 'card-held' : 'lease-lost', code: value.code, message: value.message })
    } else accept(value)
    performance.measure(`decision-desk.claim-api.${value.outcome}`, { start: started, end: performance.now() })
    return value
  }, [accept, ensureSession, persist])
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
    if (targetPending) return () => { mounted.current = false }
    void run(async () => {
      await ensureSession()
      // Server recovery is authoritative after reload. Never generate a new
      // operation for an unresolved answer whose first response was lost.
      const recovered = await deskCall<{ submissions: Array<{ operation_id: string; selection: DeskResult['selection']; state: string; next: DeskSubmit['next']; resolve_wait?: string }> }>('submission-state', { review_session_token: context.current.token })
      const retained = recovered.submissions[0]
      if (retained && context.current.lease) {
        const packet = await deskCall<DeskPacket>(`packet?id=${encodeURIComponent(retained.selection.packet_id)}`)
        accept({ outcome: 'lease-lost', packet, lease_token: context.current.lease })
      }
      const response = await claimNext(claimRef.current?.packet?.packet.binding.card_id ?? initialTarget.current, true)
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
          context.current.attempts[key] ??= { ...attempt.selection, operation_id: attempt.operation_id, lease_token: held.lease_token,
            review_session_token: context.current.token, next: attempt.next, ...(attempt.resolve_wait ? { resolve_wait: attempt.resolve_wait } : {}) }
          setResult({ outcome: attempt.state, operation_id: attempt.operation_id, selection: attempt.selection, message: 'Retained answer recovered. Retry the same operation without advancing.' })
        }
      }
      persist()
    })
    return () => { mounted.current = false }
  }, [accept, claimNext, ensureSession, persist, run, targetPending])
  // Cached-source revalidation, never research. Visibility/focus avoid an
  // unattended polling loop; the lease expiry is also enforced locally.
  useEffect(() => {
    const check = () => { if (!targetPending && !document.hidden && !lock.current && !(claimRef.current?.packet && context.current.attempts[requestKey(claimRef.current.packet)])) void run(async () => { await claimNext(claimRef.current?.packet?.packet.binding.card_id, true) }) }
    window.addEventListener('focus', check)
    const timer = setInterval(check, 30_000)
    return () => { window.removeEventListener('focus', check); clearInterval(timer) }
  }, [claimNext, run, targetPending])
  const select = (packet: DeskPacket, option: string) => {
    if (context.current.attempts[requestKey(packet)]) return
    context.current.selections[requestKey(packet)] = option; persist()
  }
  const submit = (confirmed = false) => run(async () => {
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
    context.current.attempts[key] = input; persist()
    const saved = await deskCall<DeskResult>('submit', input)
    setResult(saved)
    if (saved.outcome === 'recorded' || saved.outcome === 'recorded-empty') {
      delete context.current.attempts[key]; delete context.current.selections[key]; persist()
      visibleMeasure.current = { name: `decision-desk.submit-visible.${saved.next?.outcome ?? 'unavailable'}`, started }
      accept(saved.next ?? { outcome: 'next-unavailable' })
      setNotice(saved.next?.packet ? 'Decision recorded. Next decision loaded. Recorded; awaiting worker acknowledgment.' : 'Decision recorded. Recorded; awaiting worker acknowledgment.')
      performance.measure(`decision-desk.submit-to-next.${saved.next?.outcome ?? 'unavailable'}`, { start: started, end: performance.now() })
    }
  }, true)
  const release = (action: 'skip' | 'research', reason = '') => run(async () => {
    context.current.release ??= { operation_id: crypto.randomUUID(), action, reason: reason.trim() || (action === 'skip' ? 'Reviewer skipped without an answer' : 'Reviewer requested more research') }; persist()
    const response = await deskCall<{ outcome: string; next?: DeskClaim; code?: string; message?: string }>('release', { ...context.current.release, review_session_token: context.current.token, lease_token: context.current.lease })
    if (!response.next) {
      setError(response.message ?? 'Release not confirmed. Current card retained.')
      if (response.code && claimRef.current?.packet) accept({ ...claimRef.current, outcome: 'lease-lost', code: response.code })
      return
    }
    const released = claimRef.current?.packet
    if (released) { delete context.current.attempts[requestKey(released)]; delete context.current.selections[requestKey(released)]; persist() }
    context.current.release = undefined; setResult(null); setNotice(action === 'skip' ? 'Skipped without an answer.' : 'Research requested without an answer. No preparation runner is configured.')
    accept(response.next)
  })
  return { claim, parts: claim?.packet ? [claim.packet] : [], snapshot, policy, sessions, busy, error, result, notice, revision,
    currentSession: context.current.id, selections: context.current.selections, attempts: context.current.attempts,
    select, submit, release, refresh, retryClaim: () => run(async () => {
      const held = await claimNext(claimRef.current?.packet?.packet.binding.card_id, true)
      if (held.packet && held.lease_token) {
        const attempt = context.current.attempts[requestKey(held.packet)]
        if (attempt && (attempt.lease_token !== held.lease_token || attempt.packet_id !== held.packet.id)) {
          attempt.original_lease_token ??= attempt.lease_token; attempt.lease_token = held.lease_token
          attempt.packet_id = held.packet.id; attempt.packet_version = held.packet.version; persist()
        }
        if (held.outcome !== 'packet-invalidated') setResult(null)
      }
    }),
    claimAvailable: () => run(async () => { await claimNext(undefined, true) }),
    claimCard: (card: string) => run(async () => { await claimNext(card) }),
    newSession: () => run(async () => {
      if (claimRef.current?.lease || Object.keys(context.current.attempts).length) throw new Error('Finish or skip this session’s held decision before creating another here. Other browser contexts can create independent sessions.')
      context.current = fresh(); persist(); await claimNext()
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
