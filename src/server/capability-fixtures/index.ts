/**
 * Provider capability fixtures — a frozen characterization layer.
 *
 * These fixtures record the NATIVE signals each agent CLI emits today, before
 * any provider abstraction exists. They are deliberately *not* a normalized
 * contract: every shape here mirrors the vendor's wire format verbatim,
 * including the fields Tinstar currently ignores. The point is that when the
 * provider capability plane lands, the normalizer has a red line to hold —
 * "this is what the source actually gives us, including when it gives us
 * nothing".
 *
 * Provenance and sanitization rules live in ./README.md. Nothing in this
 * directory may contain real account usage, tokens, credentials, prompts, or
 * private repository content.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/*  Native shapes (documentation types — intentionally all-optional)    */
/* ------------------------------------------------------------------ */

/**
 * One line of a Codex rollout JSONL. `type` is the envelope discriminator
 * (`session_meta` | `turn_context` | `event_msg` | `response_item` |
 * `compacted` | `world_state`); for `event_msg` and `response_item` the real
 * discriminator is the nested `payload.type`.
 */
export interface CodexRolloutLine {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown> | null
}

/** A Claude statusline push, as piped to the statusline hook on stdin. */
export type ClaudeStatuslinePayload = Record<string, unknown>

/* ------------------------------------------------------------------ */
/*  Fixture names                                                      */
/* ------------------------------------------------------------------ */

export const CLAUDE_STATUSLINE_FIXTURES = [
  /** Every field CC 2.1.220 emits: rate_limits, context_window, cost, model. */
  'statusline-full',
  /** Fresh session before its first API response — no `rate_limits` key at all. */
  'statusline-no-rate-limits',
  /** Only the five-hour bucket is present; seven_day is absent. */
  'statusline-five-hour-only',
  /** rate_limits present, `context_window` key absent (older CC). */
  'statusline-no-context-window',
  /** context_window present but missing `context_window_size`. */
  'statusline-partial-context',
] as const
export type ClaudeStatuslineFixture = (typeof CLAUDE_STATUSLINE_FIXTURES)[number]

export const CODEX_ROLLOUT_FIXTURES = [
  /** A complete root thread: meta → turn_context → task → token_count → complete. */
  'rollout-root-session',
  /** A resumed interactive session: one rollout and identity, with a second turn appended. */
  'rollout-resumed-session',
  /** A spawned subagent: fresh child identity, parent lineage, compaction, and abort. */
  'rollout-spawned-thread',
  /** token_count events with absent rate_limits / model_context_window / info. */
  'rollout-partial-token-count',
  /** Blank + non-JSON + truncated tail; non-JSON stands in for task_started. */
  'rollout-malformed-tail',
] as const
export type CodexRolloutFixture = (typeof CODEX_ROLLOUT_FIXTURES)[number]

export const TERMINAL_CAPTURE_FIXTURES = [
  'codex-running',
  'codex-idle',
  'claude-running',
  'claude-idle',
  'claude-permission-modal',
  'claude-dev-channel-warning',
  'claude-startup-banner',
  'cursor-trust-modal',
  'agent-exited-shell',
] as const
export type TerminalCaptureFixture = (typeof TERMINAL_CAPTURE_FIXTURES)[number]

/* ------------------------------------------------------------------ */
/*  Loaders                                                            */
/* ------------------------------------------------------------------ */

/** Absolute path to a Claude statusline fixture. */
export function claudeStatuslinePath(name: ClaudeStatuslineFixture): string {
  return join(FIXTURE_ROOT, 'claude', `${name}.json`)
}

/** Parsed Claude statusline payload. Returned as an opaque record because the
 *  fixtures deliberately include partial and absent fields. */
export function loadClaudeStatusline(name: ClaudeStatuslineFixture): ClaudeStatuslinePayload {
  return JSON.parse(readFileSync(claudeStatuslinePath(name), 'utf-8')) as ClaudeStatuslinePayload
}

/** Absolute path to a Codex rollout JSONL fixture. */
export function codexRolloutPath(name: CodexRolloutFixture): string {
  return join(FIXTURE_ROOT, 'codex', `${name}.jsonl`)
}

/** Raw JSONL text of a Codex rollout fixture, bytes unchanged. */
export function readCodexRolloutText(name: CodexRolloutFixture): string {
  return readFileSync(codexRolloutPath(name), 'utf-8')
}

/**
 * Parsed Codex rollout lines. Blank and unparseable lines are skipped the same
 * way every production reader skips them, so a fixture can carry malformed
 * content without breaking callers that only care about the good records.
 */
export function loadCodexRollout(name: CodexRolloutFixture): CodexRolloutLine[] {
  const out: CodexRolloutLine[] = []
  for (const line of readCodexRolloutText(name).split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as CodexRolloutLine)
    } catch {
      // Intentional: malformed lines are part of what these fixtures record.
    }
  }
  return out
}

/** Every `event_msg` payload of a given nested `payload.type` in a rollout. */
export function codexEventPayloads(
  name: CodexRolloutFixture,
  eventType: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of loadCodexRollout(name)) {
    if (line.type !== 'event_msg') continue
    const p = line.payload
    if (p && p.type === eventType) out.push(p)
  }
  return out
}

/** A frozen tmux `capture-pane` rendering, used to characterize liveness and
 *  modal states without driving a real terminal. */
export function loadTerminalCapture(name: TerminalCaptureFixture): string {
  return readFileSync(join(FIXTURE_ROOT, 'terminal', `${name}.txt`), 'utf-8')
}

/** Recorded Prometheus/OTLP telemetry expectations for the Claude surface. */
export function loadClaudeTelemetryFixture(): {
  clock: { systemTimeIso: string; tzOffsetMinutes: number }
  opts: { userEmail: string; sessionId: string }
  metricInventory: { metrics: string[]; labels: string[]; typeSelectors: string[] }
  expectedQueries: { todayHudGlobal: string[]; todayHudSession: string[]; burningSessions: string[]; sessionSeries: string[] }
  promResponses: { match: string[]; result: { metric: Record<string, string>; value: [number, string] }[] }[]
  expectedSnapshot: Record<string, unknown>
} {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, 'claude', 'telemetry-otlp.json'), 'utf-8'))
}
