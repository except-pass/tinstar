import type { HudSnapshot, ModelBreakdown } from './types.js'

interface PromResult {
  metric: Record<string, string>
  value: [number, string]
}
interface PromResponse {
  status: 'success' | 'error'
  data?: { resultType: string; result: PromResult[] }
  error?: string
}

export interface HudQueryOpts {
  userEmail: string
  tzOffsetMinutes: number   // minutes west of UTC; matches Date.getTimezoneOffset()
  sessionName?: string      // present → per-session scope
}

export class TelemetryQuery {
  private lastSnapshot: HudSnapshot | null = null
  private lastSnapshotAt = 0
  constructor(private readonly baseUrl: string) {}

  async todayHud(opts: HudQueryOpts): Promise<HudSnapshot> {
    try {
      const snap = await this.queryHud(opts)
      this.lastSnapshot = snap
      this.lastSnapshotAt = Date.now()
      return snap
    } catch (err) {
      if (this.lastSnapshot) {
        return { ...this.lastSnapshot, staleSeconds: Math.round((Date.now() - this.lastSnapshotAt) / 1000) }
      }
      throw err
    }
  }

  private secondsSinceLocalMidnight(tzOffsetMinutes: number): number {
    const now = new Date()
    const local = new Date(now.getTime() - tzOffsetMinutes * 60_000)
    const midnight = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()))
    const midnightActual = new Date(midnight.getTime() + tzOffsetMinutes * 60_000)
    return Math.max(1, Math.floor((now.getTime() - midnightActual.getTime()) / 1000))
  }

  private async queryHud(opts: HudQueryOpts): Promise<HudSnapshot> {
    const windowSec = this.secondsSinceLocalMidnight(opts.tzOffsetMinutes)
    const filter = this.buildLabelFilter(opts)

    const [costTotal, costByModel, tokensTotal, rateMin, rateHour, cacheHit, cliSec, userSec] = await Promise.all([
      this.instant(`sum(increase(claude_code_cost_usage_USD_total${filter}[${windowSec}s]))`),
      this.instantVec(`sum by (model) (increase(claude_code_cost_usage_USD_total${filter}[${windowSec}s]))`),
      this.instant(`sum(increase(claude_code_tokens_used_total${filter}[${windowSec}s]))`),
      this.instant(`sum(rate(claude_code_tokens_used_total${filter}[1m])) * 60`),
      this.instant(`sum(rate(claude_code_tokens_used_total${filter}[1h])) * 3600`),
      this.instant(`sum(rate(claude_code_cache_read_input_tokens_total${filter}[${windowSec}s])) / sum(rate(claude_code_tokens_used_total${filter}[${windowSec}s]))`),
      this.instant(`sum(claude_code_active_time_seconds_total${this.mergeFilter(filter, 'type="cli"')})`),
      this.instant(`sum(claude_code_active_time_seconds_total${this.mergeFilter(filter, 'type="user"')})`),
    ])

    const byModel: ModelBreakdown = {}
    for (const r of costByModel) {
      const model = r.metric.model ?? 'unknown'
      byModel[model] = Number(r.value[1])
    }

    const ratio = (cliSec === null || userSec === null || userSec === 0) ? null : cliSec / userSec
    const cacheHitPct = (cacheHit !== null && isFinite(cacheHit)) ? cacheHit : null
    return {
      window: 'today',
      state: 'ready',
      cost: { total: costTotal, byModel },
      tokens: { total: tokensTotal },
      rate: { perMin: rateMin, perHour: rateHour },
      cacheHitPct,
      autonomy: { ratio, cliSeconds: cliSec, userSeconds: userSec },
    }
  }

  private buildLabelFilter(opts: HudQueryOpts): string {
    const parts: string[] = []
    if (opts.userEmail) parts.push(`user_email="${opts.userEmail}"`)
    if (opts.sessionName) parts.push(`tinstar_session="${opts.sessionName}"`)
    return parts.length ? `{${parts.join(',')}}` : ''
  }

  private mergeFilter(existing: string, extra: string): string {
    if (!existing) return `{${extra}}`
    return existing.replace(/}$/, `,${extra}}`)
  }

  private async instant(query: string): Promise<number | null> {
    const vec = await this.instantVec(query)
    if (vec.length === 0) return null
    return Number(vec[0].value[1])
  }

  private async instantVec(query: string): Promise<PromResult[]> {
    const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`prom query failed: ${res.status}`)
    const json = (await res.json()) as PromResponse
    if (json.status !== 'success' || !json.data) throw new Error(`prom query error: ${json.error ?? 'unknown'}`)
    return json.data.result
  }
}
