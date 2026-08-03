/**
 * Check session time-usage reconstruction against real transcripts.
 *
 * Unit tests run on fixtures. This runs on the actual sessions on this machine,
 * which is the only way to catch a reader that is subtly wrong in a way no
 * fixture reproduces. Run with:
 *
 *   env -u NODE_ENV npx tsx scripts/timeline-check.ts
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildSessionTimeline, findCodexCandidates, pickCodexRollout, BAND_KINDS } from '../src/server/sessions/timeline/index'

const SESSIONS = join(homedir(), '.config', 'tinstar', 'sessions')
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')
const CODEX_ROOT = join(homedir(), '.codex', 'sessions')

/** Bands must sum to wall clock — the property the whole UI rests on (R2). */
const TOLERANCE = 0.005

const hrs = (s: number): string => (s / 3600).toFixed(1).padStart(6) + 'h'

function claudePath(workdir: string | null, convId: string | null): string | null {
  if (!workdir || !convId) return null
  const direct = join(CLAUDE_PROJECTS, workdir.replace(/\//g, '-'), `${convId}.jsonl`)
  if (existsSync(direct)) return direct
  if (!existsSync(CLAUDE_PROJECTS)) return null
  for (const d of readdirSync(CLAUDE_PROJECTS)) {
    const p = join(CLAUDE_PROJECTS, d, `${convId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

let failures = 0

for (const name of readdirSync(SESSIONS).sort()) {
  const metaPath = join(SESSIONS, name, 'session.json')
  if (!existsSync(metaPath)) continue
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  const adapter: string = meta.adapter ?? 'claude'
  const workdir: string | null = meta.workspace?.path ?? null
  const createdSec = Date.parse(meta.created) / 1000

  const transcriptPath = adapter === 'codex'
    ? (workdir ? pickCodexRollout(createdSec, findCodexCandidates(CODEX_ROOT, workdir)) : null)
    : claudePath(workdir, meta.conversation?.id ?? null)

  const t0 = Date.now()
  const tl = buildSessionTimeline({ name, adapter, transcriptPath, createdSec })
  const ms = Date.now() - t0

  if (!tl) {
    console.log(`${name.padEnd(16)} ${adapter.padEnd(6)}  no transcript resolved`)
    continue
  }

  const span = tl.t1 - tl.t0
  const totals: Record<string, number> = {}
  for (const b of tl.bands) totals[b.kind] = (totals[b.kind] ?? 0) + (b.end - b.start)
  const sum = Object.values(totals).reduce((a, b) => a + b, 0)
  const drift = Math.abs(sum - span) / Math.max(span, 1)
  const ok = drift <= TOLERANCE
  if (!ok) failures++

  const sizeMb = transcriptPath ? (statSync(transcriptPath).size / 1e6).toFixed(1) : '?'
  console.log(
    `${name.padEnd(16)} ${adapter.padEnd(6)} span${hrs(span)} sum${hrs(sum)} ` +
    `${ok ? 'ok  ' : 'DRIFT'} ${String(tl.marks.length).padStart(4)} marks ` +
    `${String(tl.turns.length).padStart(3)} turns ${sizeMb.padStart(5)}MB ${String(ms).padStart(5)}ms`,
  )
  const parts = BAND_KINDS
    .filter(k => (totals[k] ?? 0) > 0)
    .sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0))
    .map(k => `${k}=${((totals[k] ?? 0) / span * 100).toFixed(0)}% (${hrs(totals[k] ?? 0).trim()})`)
  console.log(`${''.padEnd(17)}${parts.join('  ')}`)
}

if (failures > 0) {
  console.error(`\n${failures} session(s) whose bands do not sum to their span — flatten is dropping or double-counting time.`)
  process.exit(1)
}
console.log('\nAll sessions: bands sum to wall clock.')
