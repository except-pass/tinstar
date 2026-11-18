import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { readClavisValue } from '../reconciliation/decisionPrep'

export const jevModel = 'typesafe/jev-1.14'
const decisionsUrl = 'https://openrouter.ai/api/alpha/decisions'
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
export type Question = ChoiceQuestion | NoulQuestion
export type DecisionRequest = { state: object; questions: Record<string, Question> }

const probability = z.number().finite().min(0).max(1)
const choice = z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(probability), confidence: probability })
const noul = z.object({ type: z.literal('noul'), noul: probability })
const decision = z.object({
  model: z.string().regex(/^typesafe\/jev-1\.14(?:-\d{8})?$/),
  answers: z.record(z.discriminatedUnion('type', [choice, noul])),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
    cost: z.number().finite().nonnegative().nullish(),
  }).nullish(),
})

export type JevResponse = z.infer<typeof decision> & { latencyMs: number; attempts: number }
export type ChoiceAnswer = z.infer<typeof choice>
export type JevErrorCode = 'credential-unavailable' | 'rate-limited' | 'provider-http' | 'provider-timeout' | 'provider-network' | 'provider-shape'
export class JevError extends Error {
  constructor(readonly code: JevErrorCode, readonly status?: number) {
    super(status ? `OpenRouter Decisions failed (HTTP ${status})` : `OpenRouter Decisions failed (${code})`)
  }
}

async function loadKey() {
  const raw = await readClavisValue('openrouter/api-key')
  if (!raw) return null
  try {
    const key = JSON.parse(raw)?.OPENROUTER_API_KEY
    return typeof key === 'string' && key.trim() ? key.trim() : null
  } catch { return null }
}

function retryAfterMs(value: string | null, now: number) {
  if (!value?.trim()) return null
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) ? Math.max(0, ms) : null
}

export class OpenRouterJev {
  private retryAt = 0

  constructor(private fetcher: typeof fetch = fetch, private keyLoader = loadKey,
    private timeoutMs = 8_000, private wait = delay) {}

  async open() {
    const key = await this.keyLoader()
    if (!key) throw new JevError('credential-unavailable')
    return (request: DecisionRequest) => this.decide(request, key)
  }

  private async decide(request: DecisionRequest, key: string): Promise<JevResponse> {
    const body = JSON.stringify({ model: jevModel, ...request }).replaceAll(key, '[credential omitted]')
    const started = performance.now()
    for (let attempt = 1; ; attempt++) {
      while (Date.now() < this.retryAt) {
        const remaining = this.retryAt - Date.now()
        // Long provider cooldowns remain in effect for later calls. Keep a
        // foreground classification from waiting minutes for quota to reset.
        if (remaining > this.timeoutMs) throw new JevError('rate-limited', 429)
        await this.wait(remaining)
      }
      const signal = AbortSignal.timeout(this.timeoutMs)
      let result: Response
      try {
        result = await this.fetcher(decisionsUrl, {
          method: 'POST', redirect: 'error', signal, body,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        })
      } catch {
        if (attempt < 3) { await this.wait(200 * 2 ** (attempt - 1)); continue }
        throw new JevError(signal.aborted ? 'provider-timeout' : 'provider-network')
      }
      if (!result.ok) {
        const status = result.status
        await result.body?.cancel().catch(() => {})
        const backoff = 250 * 2 ** (attempt - 1)
        if (status === 429) {
          const now = Date.now()
          this.retryAt = Math.max(this.retryAt, now + (retryAfterMs(result.headers.get('Retry-After'), now) ?? backoff))
          if (attempt < 3) continue
        } else if (attempt < 3 && (status === 408 || status >= 500)) {
          await this.wait(backoff)
          continue
        }
        throw new JevError(status === 429 ? 'rate-limited' : 'provider-http', status)
      }
      let raw: unknown
      try { raw = await result.json() }
      catch {
        if (signal.aborted && attempt < 3) continue
        throw new JevError(signal.aborted ? 'provider-timeout' : 'provider-shape')
      }
      const parsed = decision.safeParse(raw)
      if (!parsed.success) throw new JevError('provider-shape')
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = parsed.data.answers[id]
        if (!answer || answer.type !== question.type) throw new JevError('provider-shape')
        if (answer.type === 'choice') {
          const keys = Object.keys(question.criteria)
          const probs = answer.probabilities
          // Reject wrong candidate IDs and incomplete distributions instead of
          // ranking them as though the provider considered every destination.
          if (keys.length !== Object.keys(probs).length || !keys.every(key => Object.hasOwn(probs, key)) ||
            !Object.hasOwn(question.criteria, answer.choice) ||
            Object.values(probs).some(p => p > probs[answer.choice]! + 0.001) ||
            Math.abs(Object.values(probs).reduce((sum, p) => sum + p, 0) - 1) > 0.03) {
            throw new JevError('provider-shape')
          }
        }
      }
      return { ...parsed.data, latencyMs: Math.round(performance.now() - started), attempts: attempt }
    }
  }
}
