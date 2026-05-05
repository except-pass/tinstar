import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UsageEntry } from '../../lib/slashMatching'

const LEADING_SLASH_RE = /^\/([A-Za-z0-9_:-]+)/

export function extractLeadingSlashName(text: string): string | null {
  const trimmed = text.trimStart()
  // Whitespace was trimmed; if `/` is now first, original was at start (no
  // non-whitespace before it).
  const m = trimmed.match(LEADING_SLASH_RE)
  return m ? m[1]! : null
}

export interface SlashUsageOpts {
  cap?: number
}

const DEFAULT_CAP = 1000

function isValidEntry(e: unknown): e is UsageEntry {
  if (!e || typeof e !== 'object') return false
  const obj = e as Record<string, unknown>
  if (typeof obj.count !== 'number' || !Number.isFinite(obj.count) || obj.count < 0) return false
  if (typeof obj.lastUsedAt !== 'string') return false
  const t = Date.parse(obj.lastUsedAt)
  if (!Number.isFinite(t)) return false
  return true
}

export class SlashUsage {
  private data: Record<string, UsageEntry> = {}
  private dirty = false
  private cap: number

  constructor(private filePath: string, opts: SlashUsageOpts = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      const out: Record<string, UsageEntry> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isValidEntry(v)) out[k] = v
      }
      this.data = out
    } catch {
      // Corrupt file — start fresh.
      this.data = {}
    }
  }

  snapshot(): Record<string, UsageEntry> {
    return this.data
  }

  increment(name: string): void {
    const now = new Date().toISOString()
    const cur = this.data[name]
    this.data[name] = { count: (cur?.count ?? 0) + 1, lastUsedAt: now }
    this.dirty = true
    this.evictIfNeeded()
  }

  private evictIfNeeded(): void {
    const keys = Object.keys(this.data)
    if (keys.length <= this.cap) return
    const sorted = keys
      .map(k => ({ k, t: Date.parse(this.data[k]!.lastUsedAt) }))
      .sort((a, b) => a.t - b.t)
    const drop = sorted.slice(0, keys.length - this.cap)
    for (const { k } of drop) delete this.data[k]
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
    this.dirty = false
  }
}
