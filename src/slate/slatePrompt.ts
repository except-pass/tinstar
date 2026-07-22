// The prompts an agent receives when the user acts on one of its Slate points —
// adds a point, replies on a thread, or submits a control answer.
//
// Same delivery pattern as the Roundup notices (src/notices/followUpPrompt.ts,
// answerPrompt.ts) and note replies (src/pins/replyPrompt.ts): the server bakes a
// human-readable block — including the exact curl the agent should run to reply —
// and submits it to the run's session (the point's `runId`, which IS the tmux
// session name). The point/reply is already persisted before this is delivered, so
// delivery is best-effort; an unreachable session just means the agent reads it
// later. React-free, server-only (rides the esbuild bundle with the answer route).
//
// The injection guardrail (plan KTD6): an injected comment is a NOTE, not a command
// to drop in-flight work. Every prompt says so, so a mid-tool-use injection can't
// derail the agent into abandoning what it was doing.
import type { Point } from '../domain/types'
import type { Reply } from '../domain/pinSet'

/** How many of the most recent thread messages a prompt carries — bounds the
 *  delivered prompt regardless of how long a chatty point's thread grows (mirrors
 *  followUpPrompt's PROMPT_THREAD_WINDOW). */
export const SLATE_PROMPT_THREAD_WINDOW = 20

/** The GUARDRAIL line every Slate injection carries (plan KTD6/R15). */
const GUARDRAIL =
  'This is a note on the run\'s Slate, not a command to drop what you are doing — ' +
  'finish or checkpoint your in-flight work first, then act on it.'

/** The thread rendered for a prompt: one line per message, oldest first, windowed
 *  to the last SLATE_PROMPT_THREAD_WINDOW messages. */
export function slateThreadSoFar(replies: Reply[]): string {
  return replies.slice(-SLATE_PROMPT_THREAD_WINDOW).map(m => `[${m.author}] ${m.text}`).join('\n')
}

/** The curl block telling the agent how to reply onto a point's thread. */
function replyCurl(point: Point, origin: string): string[] {
  return [
    `curl -s -X POST '${origin}/api/runs/${point.runId}/slate/points/${point.id}/replies' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"author":"agent","text":"YOUR REPLY"}'`,
  ]
}

/** Collapse a headline to a single line before embedding it in a delivered prompt.
 *  A headline is only .trim()'d at ingestion, so embedded newlines would otherwise
 *  survive verbatim into the agent's tmux prompt — a multi-line "SYSTEM: …" headline
 *  could inject directives past the guardrail. Collapse all whitespace runs to a
 *  single space so the headline stays one quoted line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Prompt for a brand-new USER-added point (POST /slate/points). */
export function slatePointPromptText(point: Point, origin: string): string {
  return [
    `The user added a point to your run's Slate: "${oneLine(point.headline)}" (point ${point.id}).`,
    '',
    GUARDRAIL,
    '',
    'Reply on its thread when you have something to say:',
    ...replyCurl(point, origin),
  ].join('\n')
}

/** Prompt for a USER reply on a point's thread (POST /slate/points/:pid/replies).
 *  `point` must already carry the appended reply as the last thread entry. */
export function slateReplyPromptText(point: Point, origin: string): string {
  const thread = point.replies ?? []
  const latest = thread[thread.length - 1]?.text ?? ''
  const lines: string[] = [
    `The user replied on a point on your run's Slate: "${oneLine(point.headline)}" (point ${point.id}).`,
    '',
    `Their message: ${latest}`,
    '',
    GUARDRAIL,
  ]
  if (thread.length > 1) {
    lines.push(
      '',
      thread.length > SLATE_PROMPT_THREAD_WINDOW
        ? `The thread so far (the last ${SLATE_PROMPT_THREAD_WINDOW} of ${thread.length} messages):`
        : 'The thread so far:',
      slateThreadSoFar(thread),
    )
  }
  lines.push('', 'Reply on its thread:', ...replyCurl(point, origin))
  return lines.join('\n')
}

/** Prompt for a USER control answer (POST /slate/points/:pid/answer). `chosenLabels`
 *  are the human labels of the selected choice ids; `text` the free-text note. */
export function slateAnswerPromptText(
  point: Point,
  chosenLabels: string[],
  text: string | undefined,
  origin: string,
): string {
  const lines: string[] = [
    `The user answered a control on your run's Slate: "${oneLine(point.headline)}" (point ${point.id}).`,
  ]
  if (chosenLabels.length > 0) lines.push(`They chose: ${chosenLabels.join(', ')}`)
  if (text) lines.push(`They added: ${text}`)
  lines.push('', GUARDRAIL, '', 'Reply on its thread once you have acted:', ...replyCurl(point, origin))
  return lines.join('\n')
}

/** Prompt for a REFRESH nudge (POST /slate/surfaces/:pid/refresh). Refresh persists
 *  NOTHING (plan KTD2): this text is delivered best-effort and the surface regenerates
 *  through the normal file→watcher→projection path. When the surface carries a
 *  file-owned `refresh` recipe, the delivered text IS that recipe verbatim, plus a
 *  one-line instruction to rewrite the surface's `.tinstar/slate` file; otherwise a
 *  bare regenerate-nudge naming the surface. `_origin` is unused (regeneration is
 *  file-based, not a curl) but kept for signature parity with the other builders. */
export function slateRefreshPromptText(point: Point, _origin: string): string {
  const body = point.refresh
    ? [point.refresh, '', `Then rewrite .tinstar/slate/${point.id}.json with the regenerated surface.`]
    : [`Regenerate the Slate surface "${oneLine(point.headline)}" (surface ${point.id}) and rewrite its .tinstar/slate file.`]
  // Carry the GUARDRAIL like every other Slate prompt: the recipe is file-authored
  // (an untrusted repo/branch/process could plant one), so frame it as a note, not a
  // command to abandon in-flight work.
  return [...body, '', GUARDRAIL].join('\n')
}

/** Prompt for the surface COMPOSER (POST /slate/compose). Persists NOTHING (KTD4):
 *  delivered best-effort; the agent authors a NEW surface by writing its
 *  `.tinstar/slate/<slug>.json`, so composition reuses the Slate's one file-in model.
 *  `parts.prompt` comes from a catalog template, `parts.freeform` from the user's own
 *  text; at least one is present (the route rejects an empty body). `_origin` is unused
 *  (authoring is file-based) but kept for signature parity. */
export function slateComposePromptText(
  parts: { prompt?: string; freeform?: string },
  _origin: string,
): string {
  const head = parts.prompt ? `Author a Slate surface. ${parts.prompt}` : 'Author a Slate surface.'
  const lines: string[] = [head]
  if (parts.freeform) lines.push(parts.freeform)
  lines.push(
    'Write it to .tinstar/slate/<slug>.json with an id, headline, A2UI content, and an optional refresh recipe.',
    '',
    GUARDRAIL,
  )
  return lines.join('\n')
}
