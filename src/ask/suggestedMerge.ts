import { apiFetch } from '../apiClient'

export interface SuggestedMergeCard { url: string; message: string }

/** Read the PR head at click time, then use the existing Clawson handoff. Tin Star does not merge. */
export async function sendSuggestedMerge(prUrl: string, operationId: string): Promise<SuggestedMergeCard> {
  const headers = { 'X-Tinstar-UI': '1' }
  const origin = await apiFetch(`/api/pulls/origin?url=${encodeURIComponent(prUrl)}`, { headers })
  const observed = await readBody(origin)
  if (!origin.ok || !observed.ok) throw new Error(observed.error?.message ?? 'Could not read this PR. Nothing was sent to Clawson.')
  const head = observed.data?.head
  if (typeof head !== 'string' || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Could not read this PR head. Nothing was sent to Clawson.')
  const response = await apiFetch('/api/pulls/clawson-merge', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation_id: operationId, targets: [{ url: prUrl, head }] }),
  })
  const body = await readBody(response)
  if (!response.ok || !body.ok || !body.data?.url || !body.data.message) throw new Error(body.error?.message ?? 'Could not send to Clawson. Retry this click.')
  return { url: body.data.url, message: body.data.message }
}

async function readBody(response: Response): Promise<{ ok?: boolean; data?: { head?: unknown; url?: string; message?: string }; error?: { message?: string } }> {
  try { return await response.json() } catch { throw new Error('Could not send to Clawson. Retry this click.') }
}
