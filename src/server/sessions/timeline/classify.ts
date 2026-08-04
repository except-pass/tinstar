import type { Interval } from './types'

/** Tools whose span IS the user thinking about an answer (R7). */
export const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input'])

/** Tools whose span is the agent blocked on delegated work, not its own. */
export const SUBAGENT_TOOLS = new Set(['wait_agent', 'wait', 'Agent', 'Task'])

/**
 * Codex tools print their own true runtime. This is what makes approval
 * detection arithmetic rather than a guess (R5).
 */
const WALL_RE = /Wall time:?\s+([0-9.]+)\s*seconds/

/**
 * Commands that cannot legitimately take minutes — see R6.
 *
 * Matched against the resolved command WORD, never as a substring of the raw
 * argument blob. Substring matching read `docker run --rm` and
 * `pytest tests/warm-rm-cache` as approval stalls, because `--rm` and a path
 * segment both satisfy a `\brm\b` word boundary. `git push` is deliberately
 * absent: pushing a large repository genuinely takes minutes, so it produced
 * false stalls without catching real ones.
 */
const TRIVIAL_COMMANDS = new Set(['rm', 'rmdir', 'mv', 'chmod', 'chown', 'kill', 'touch', 'ln'])

/** Pull the `cmd` string out of either a JSON argument object or `exec` script source. */
function extractCommand(args: string): string {
  const m = /["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(args)
  if (!m) return ''
  const raw = m[1]!
  try {
    return JSON.parse(raw.startsWith("'") ? `"${raw.slice(1, -1).replace(/"/g, '\\"')}"` : raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

/**
 * The program a command actually runs: shell wrapper unwrapped, leading
 * environment assignments skipped, directory prefix stripped.
 */
export function commandHead(args: string): string {
  let cmd = extractCommand(args).trim()
  if (!cmd) return ''
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(cmd)
  if (wrapped) cmd = wrapped[2]!.trim()
  const tokens = cmd.split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  return (tokens[i] ?? '').replace(/^.*\//, '')
}

/** Below this, an unexplained gap is scheduling noise rather than a human. */
const MIN_APPROVAL_GAP_SEC = 45

/** Beyond this, even an unmeasurable trivial command is assumed parked. */
const HEURISTIC_MIN_SEC = 300

/**
 * A rejected permission opens with one of these sentences.
 *
 * Anchored at the START of the decoded result text, never matched anywhere
 * inside it. A substring test turned any tool output that merely *quoted* the
 * sentence into a red "you blocked this" band — including a grep over this very
 * file, which contains the strings below.
 */
const REJECT_OPENERS = [
  "the user doesn't want to proceed",
  'the user doesn’t want to proceed',
  'the user rejected',
  'tool use was rejected',
]

/** True when the result text itself is a rejection notice, not merely quoting one. */
export function isRejectionText(resultText: string): boolean {
  const t = resultText.trim().toLowerCase()
  return REJECT_OPENERS.some(marker => t.startsWith(marker))
}

const snip = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 160)

/**
 * One Codex tool call → one or two intervals.
 *
 * The load-bearing case: `exec_command` reports how long the process actually
 * ran. Any time the call existed but the process was not running was time
 * parked on an approval prompt. When a command reports 0.0 seconds and its
 * result arrives 8 hours later, that is not a slow tool — that is a prompt
 * nobody answered (R5).
 */
export function classifyCodexCall(
  start: number,
  end: number,
  name: string,
  args: string,
  output: string,
): Interval[] {
  const detail = snip(args)
  const span = end - start
  const base = { name, detail }

  if (SUBAGENT_TOOLS.has(name)) return [{ start, end, kind: 'subagent', ...base }]
  if (QUESTION_TOOLS.has(name)) return [{ start, end, kind: 'question', ...base }]

  const m = WALL_RE.exec(output)
  if (m) {
    const ran = Number.parseFloat(m[1]!)
    const gap = span - ran
    if (gap > MIN_APPROVAL_GAP_SEC && ran < span / 2) {
      const out: Interval[] = [{ start, end: start + gap, kind: 'approval', ...base }]
      // The prompt is answered first, then the command runs — so the tool tail
      // comes after the stall, not before it.
      if (ran > 0.05) out.push({ start: start + gap, end, kind: 'tool', ...base })
      return out
    }
    // Deliberately fall through rather than returning tool here. A matched
    // `Wall time` does not mean the runtime is *usable*: Codex's script-wrapped
    // `exec` reports elapsed-including-stall, so it always matches and always
    // fails the gap test above. Returning early at this point silently
    // reclassified 12.6h of real approval stalls as tool time on the session
    // this feature was built to explain.
  }

  // The runtime was absent or unusable, so subtraction found nothing to
  // subtract. Fall back to: a trivial command cannot honestly take minutes
  // (R6). This is a heuristic and is documented as one.
  if (
    span > HEURISTIC_MIN_SEC &&
    (name === 'exec' || name === 'exec_command') &&
    TRIVIAL_COMMANDS.has(commandHead(args))
  ) {
    return [{ start, end, kind: 'approval', ...base }]
  }

  // Known blind spot: a genuine stall on a command that CAN legitimately run
  // long (`npm publish`, a slow build) is indistinguishable from the command
  // simply taking that long, once the runtime is unusable. It reads as tool
  // time. Under-reporting is the right failure direction — inventing a stall
  // tells the user they are the blocker when they are not.

  return [{ start, end, kind: 'tool', ...base }]
}

/**
 * One Claude tool call → one interval.
 *
 * Note what is absent: an *approved* Claude permission prompt leaves no trace
 * in the transcript, so it still reads as tool time. That is the feature's one
 * acknowledged blind spot (R8); closing it needs a live recorder.
 */
export function classifyClaudeCall(
  start: number,
  end: number,
  name: string,
  args: string,
  resultText: string,
  isError: boolean,
): Interval {
  const base = { name, detail: snip(args) }
  if (QUESTION_TOOLS.has(name)) return { start, end, kind: 'question', ...base }
  if (SUBAGENT_TOOLS.has(name)) return { start, end, kind: 'subagent', ...base }

  if (isRejectionText(resultText)) {
    return { start, end, kind: 'approval', name: `${name} (rejected)`, detail: base.detail }
  }

  // A failed tool still occupied real time. The failure is reported as a mark
  // in the gutter, not by recolouring the band.
  void isError
  return { start, end, kind: 'tool', ...base }
}

export interface PendingCall {
  start: number
  name: string
  args: string
}

/**
 * A call with no recorded output is NOT proof the agent is still parked on it.
 *
 * Codex drops the output line when a call is interrupted, and an orchestrating
 * session interrupts sub-agents constantly. Stretching such a call to "now"
 * produced a 34.9-hour phantom band that painted over a day and a half of real
 * work and inflated the measured approval total from 26% to 62%. If anything at
 * all was logged after the call, the agent had clearly moved on: close it there
 * and label it unresolved. Only a call with nothing after it is in flight (R4).
 */
export function closeUnmatched(
  pending: PendingCall[],
  entryTimes: number[],
  now: number,
): Interval[] {
  return pending.map(({ start, name, args }) => {
    const next = entryTimes.find(t => t > start)
    return {
      start,
      end: next ?? now,
      kind: 'tool' as const,
      name: next ? `${name} (no result logged)` : name,
      detail: snip(args),
    }
  })
}
