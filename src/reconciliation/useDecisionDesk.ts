import { useCallback, useEffect, useRef, useState } from 'react'
import { deskCall, type DeskClaim, type DeskResult, type DeskSession, type DeskSnapshot, type DeskSubmit } from './decisionDeskClient'

const storageKey = 'tinstar-decision-review-v2'
type Release = { operation_id: string; review_session_token: string; lease_token: string; action: 'release' | 'skip' }
interface ReviewContext {
  open: string
  token?: string
  lease?: string
  claim?: { operation_id: string; card_id?: string }
  submission?: DeskSubmit
  release?: Release
}
const fresh = (): ReviewContext => ({ open: crypto.randomUUID() })
function load(): ReviewContext {
  try { return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? fresh() } catch { return fresh() }
}
export interface DecisionTarget { id: string; cardId?: string; requestKey?: string }

export function useDecisionDesk(target?: DecisionTarget, onTargetConsumed?: (id: string) => void) {
  const [initial] = useState(load)
  const context = useRef(initial)
  const lock = useRef(false), firstClaim = useRef(false), handledTarget = useRef<string>()
  const [claim, setClaim] = useState<DeskClaim | null>(null)
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastCard, setLastCard] = useState<string>()
  const [message, setMessage] = useState('')
  const [option, setOption] = useState(initial.submission?.option_id ?? '')
  const [answer, setAnswer] = useState(initial.submission?.answer ?? '')
  const [saving, setSaving] = useState(!!initial.submission)

  const persist = useCallback(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(context.current)) } catch { /* The current tab still holds its capability. */ }
  }, [])
  const refresh = useCallback(async () => {
    await deskCall<DeskSnapshot>('snapshot').then(setSnapshot).catch(() => {})
  }, [])
  const run = useCallback(async (operation: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMessage('')
    try { await operation() } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Decision Desk unavailable.')
    } finally {
      lock.current = false
      setBusy(false)
      void refresh()
    }
  }, [refresh])
  const accept = useCallback((next: DeskClaim | null, keepSelection = false) => {
    context.current.lease = next?.lease_token
    setClaim(next)
    if (!keepSelection) { setOption(''); setAnswer('') }
    persist()
  }, [persist])
  const ensureSession = useCallback(async () => {
    if (context.current.token) return context.current.token
    persist()
    const opened = await deskCall<{ session: DeskSession; review_session_token: string }>('sessions',
      { operation_id: context.current.open, label: 'Browser review' })
    context.current.token = opened.review_session_token
    persist()
    return opened.review_session_token
  }, [persist])
  const claimCard = useCallback((card?: string) => run(async () => {
    firstClaim.current = true
    setLastCard(card)
    const review_session_token = await ensureSession()
    const request = context.current.claim ?? { operation_id: crypto.randomUUID(), ...(card ? { card_id: card } : {}) }
    context.current.claim = request
    persist()
    const next = await deskCall<DeskClaim>('claim', { ...request, review_session_token, lease_token: context.current.lease })
    context.current.claim = undefined
    if ((card && next.lease?.card_id !== card && !next.code) || next.outcome === 'already-holding') {
      setMessage(next.lease ? 'This session already holds a different decision. Finish or skip it before switching.' : next.message ?? 'This card is awaiting preparation.')
    } else if (next.message) setMessage(next.message)
    if (next.code === 'claim-lost' && !context.current.submission) {
      context.current = fresh()
      accept(null)
    } else if (!next.code && next.outcome !== 'already-holding') accept(next, !!context.current.submission)
    else if (!context.current.lease) setClaim(next)
    persist()
  }), [accept, ensureSession, persist, run])
  const finishRelease = useCallback(async (request: Release) => {
    const response = await deskCall<{ next?: DeskClaim | null; message?: string; code?: string }>('release', request)
    context.current.release = undefined
    if (response.code === 'claim-lost') accept(null)
    else if (response.code) { persist(); throw new Error(response.message ?? 'Release could not be confirmed.') }
    else accept(response.next ?? null)
    persist()
  }, [accept, persist])
  const release = (action: Release['action']) => run(async () => {
    const { token, lease } = context.current
    if (!token || !lease || context.current.submission) return
    const request = context.current.release ?? { operation_id: crypto.randomUUID(), review_session_token: token, lease_token: lease, action }
    context.current.release = request
    persist()
    await finishRelease(request)
  })
  const finishAnswer = useCallback(async (request: DeskSubmit) => {
    const result = await deskCall<DeskResult>('submit', request)
    setMessage(result.message)
    if (result.outcome === 'save-unconfirmed') return
    context.current.submission = undefined
    setSaving(false)
    if (result.outcome.startsWith('recorded')) accept(result.next ?? null)
    else if (result.outcome === 'lease-lost') accept(null, true)
    else if (result.outcome === 'packet-invalidated') setClaim(current => current ? { ...current, packet: null } : current)
    persist()
  }, [accept, persist])
  const submit = () => run(async () => {
    const { token, lease } = context.current
    const request = context.current.submission ?? (token && lease && option && answer.trim() ? {
      operation_id: crypto.randomUUID(), review_session_token: token, lease_token: lease, option_id: option, answer,
    } : undefined)
    if (!request) return
    context.current.submission = request
    setSaving(true)
    persist()
    await finishAnswer(request)
  })

  useEffect(() => {
    if (firstClaim.current) return
    if (context.current.submission) {
      const submission = context.current.submission
      firstClaim.current = true
      void run(() => finishAnswer(submission))
    } else if (context.current.release) {
      const pending = context.current.release
      firstClaim.current = true
      void run(() => finishRelease(pending))
    } else if (!target) {
      firstClaim.current = true
      void claimCard()
    }
  }, [claimCard, finishAnswer, finishRelease, run, target])
  useEffect(() => {
    if (!target?.cardId || handledTarget.current === target.id || busy) return
    firstClaim.current = true
    handledTarget.current = target.id
    onTargetConsumed?.(target.id)
    void claimCard(target.cardId)
  }, [busy, claimCard, onTargetConsumed, target])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  return { claim, snapshot, busy, message, lastCard, option, answer, saving, setOption, setAnswer, claimCard, release, submit }
}
