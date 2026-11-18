import { apiFetch } from '../apiClient'
import type { PreparedReviews, PreparedClaimResult } from '../server/reconciliation/preparedReviews'
import type { PreparedSubmitResult, preparedSubmitInput } from '../server/reconciliation/preparedSubmissions'
import type { z } from 'zod'

export type DeskSnapshot = Awaited<ReturnType<PreparedReviews['snapshot']>>
export type DeskClaim = PreparedClaimResult & { code?: string }
export type DeskSubmit = z.infer<typeof preparedSubmitInput>
export type DeskResult = PreparedSubmitResult
export type DeskSession = { id: string; label: string; device: string; held: { title: string | null; packet_id: string; lease: { card_id: string } } | null }

export async function deskCall<T>(path: string, value?: unknown): Promise<T> {
  const response = await apiFetch(`/api/reconciliation/decision-desk/${path}`, {
    method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  const body = await response.json()
  if (!body.ok) throw new Error(body.error?.message ?? 'Decision Desk backend unavailable')
  return body.data as T
}
