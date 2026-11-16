import { apiFetch } from '../apiClient'
import type { DecisionPacketValidation } from '../shared/decisionPacket'
import type { StoredDecisionPacket, StoredDecisionPolicy } from '../server/reconciliation/decisionPackets'
import type { PreparedReviews, PreparedClaimResult } from '../server/reconciliation/preparedReviews'
import type { PreparedSubmitResult, preparedSubmitInput } from '../server/reconciliation/preparedSubmissions'
import type { z } from 'zod'

export type DeskPacket = StoredDecisionPacket & { validation: DecisionPacketValidation; ready: boolean; reasons: string[] }
export type DeskSnapshot = Awaited<ReturnType<PreparedReviews['snapshot']>>
export type DeskPolicy = StoredDecisionPolicy
export type DeskClaim = Omit<PreparedClaimResult, 'packet'> & { packet?: DeskPacket | null; code?: string }
export type DeskSubmit = z.infer<typeof preparedSubmitInput>
export type DeskResult = Omit<PreparedSubmitResult, 'next'> & { next?: DeskClaim }
export type DeskSession = { id: string; label: string; device: string; expires_at: string; held: { title: string | null; packet_id: string; lease: { card_id: string } } | null }
export async function deskCall<T>(path: string, value?: unknown, method = 'POST'): Promise<T> {
  const response = await apiFetch(`/api/reconciliation/decision-desk/${path}`, {
    method: value === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  const body = await response.json()
  if (!body.ok) throw new Error(body.error?.message ?? 'Decision Desk backend unavailable')
  return body.data as T
}
