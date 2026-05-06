// src/lib/slashMatching.ts
export interface SlashToken {
  /** Index of the leading `/` in the original text. */
  start: number
  /** Substring after the `/` and before the cursor. */
  partial: string
}

const WS_RE = /\s/

export function findSlashToken(text: string, cursor: number): SlashToken | null {
  // Walk back from cursor through non-whitespace to find token start.
  let i = cursor - 1
  while (i >= 0 && !WS_RE.test(text[i]!)) i--
  // text[i] is whitespace or i is -1; token candidate starts at i+1.
  const tokenStart = i + 1
  if (text[tokenStart] !== '/') return null
  return { start: tokenStart, partial: text.slice(tokenStart + 1, cursor) }
}

export interface SlashCommand {
  name: string
  description: string
  source: 'project' | 'user' | 'plugin' | 'project-skill' | 'user-skill' | 'plugin-skill' | 'builtin'
  argumentHint?: string | null
}

export interface UsageEntry {
  count: number
  lastUsedAt: string  // ISO
}

const MAX_RESULTS = 5

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

function matchScore(name: string, description: string, partial: string): number {
  if (!partial) return 0
  const n = name.toLowerCase()
  const d = description.toLowerCase()
  const p = partial.toLowerCase()
  if (n === p) return 1000
  if (n.startsWith(p)) return 900 - (n.length - p.length)
  if (n.includes(p)) return 700
  if (isSubsequence(p, n)) return 500
  if (d.includes(p)) return 200
  return 0
}

function recencyBoost(lastUsedAt: string | undefined): number {
  if (!lastUsedAt) return 0
  const age = Date.now() - new Date(lastUsedAt).getTime()
  if (age < 24 * 3600_000) return 100
  if (age < 7 * 24 * 3600_000) return 30
  return 0
}

function frequencyBoost(count: number | undefined): number {
  if (!count) return 0
  return Math.min(60, Math.floor(10 * Math.log2(1 + count)))
}

export function rankCommands(
  commands: SlashCommand[],
  partial: string,
  usage: Record<string, UsageEntry>,
): SlashCommand[] {
  const scored = commands.map(cmd => {
    const u = usage[cmd.name]
    const m = matchScore(cmd.name, cmd.description, partial)
    // When partial is non-empty, require at least a description-level match.
    // Otherwise (empty partial) include everything ranked by recency + frequency.
    const score = m + recencyBoost(u?.lastUsedAt) + frequencyBoost(u?.count)
    return { cmd, score, eligible: partial === '' || m > 0 }
  })
  return scored
    .filter(s => s.eligible)
    .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
    .slice(0, MAX_RESULTS)
    .map(s => s.cmd)
}
