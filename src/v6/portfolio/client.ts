import { apiFetch } from '../../apiClient'
import type { IntentEnvelope } from '../contract/intent'
import type { PendingDisposition, PlanView, PortfolioDoc } from './types'

export interface PortfolioSubmissionView {
  requestId: string
  noteId: string | null
  disposition: PendingDisposition | string
  applied: boolean
  detail: string
  exitCode: number | null
  canReceive: boolean | 'unknown' | null
}

export interface PortfolioSubmitResult {
  submission: PortfolioSubmissionView
  board: PortfolioDoc
}

interface Envelope<T> {
  ok?: boolean
  data?: T
  error?: { message?: string }
}

async function readEnvelope<T>(res: Response): Promise<T> {
  let body: Envelope<T>
  try {
    body = await res.json() as Envelope<T>
  } catch {
    throw new Error('Portfolio request failed')
  }
  if (!res.ok || body.ok !== true || body.data === undefined) {
    throw new Error(body.error?.message || 'Portfolio request failed')
  }
  return body.data
}

export async function postPortfolioIntent(envelope: IntentEnvelope): Promise<PortfolioSubmitResult> {
  const res = await apiFetch('/api/v6/portfolio/intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  return readEnvelope<PortfolioSubmitResult>(res)
}

export async function postPortfolioReconcile(requestId: string): Promise<PortfolioDoc> {
  const res = await apiFetch('/api/v6/portfolio/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  })
  const data = await readEnvelope<{ board: PortfolioDoc }>(res)
  return data.board
}

export async function getPortfolio(): Promise<PortfolioDoc> {
  const res = await apiFetch('/api/v6/portfolio')
  const data = await readEnvelope<{ board: PortfolioDoc }>(res)
  return data.board
}

export async function getPortfolioPlan(slug: string): Promise<PlanView> {
  const res = await apiFetch(`/api/v6/portfolio/plans/${encodeURIComponent(slug)}`)
  return readEnvelope<PlanView>(res)
}
