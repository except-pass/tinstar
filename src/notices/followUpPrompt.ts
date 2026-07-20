// The prompt an agent receives when the user asks a follow-up question about one
// of its Roundup notices.
//
// Same delivery pattern as the answer path (answerPrompt.ts) and note replies
// (src/pins/replyPrompt.ts): the server bakes a human-readable block — including
// the exact curl the agent should run — and submits it to the posting session
// (notice.runId). The question is already persisted on the thread before this is
// delivered, so delivery is best-effort; an unreachable session just means the
// agent reads it later off GET /api/notices.
//
// The contract this prompt exists to enforce is BOTH-AND, not either-or:
//   (i)  reply on the thread, so the user gets an answer where they asked, and
//   (ii) AMEND the notice when the answer improves it, so the knowledge lands in
//        the entry itself.
// Reply-only is the failure mode worth designing against: the thread accumulates
// the real explanation while the card everyone reads at a glance stays wrong, and
// the next person to open the board has to read a conversation to learn what the
// notice should have said in the first place.
import type { Notice } from '../domain/types'
import type { Reply } from '../domain/pinSet'

/** How many of the most recent thread messages the prompt carries.
 *
 *  The thread is append-only and per-message length is its only other bound, so a
 *  long-lived chatty notice would otherwise re-serialize its ENTIRE history into
 *  every delivered prompt — growing the agent's context without limit for a
 *  conversation whose useful part is almost always the recent turns. Windowing
 *  bounds the prompt regardless of how long the thread gets. */
export const PROMPT_THREAD_WINDOW = 20

/** The thread rendered for the prompt: one line per message, oldest first —
 *  mirrors `threadSoFar` in the pins prompt so both read identically. Windowed to
 *  the last `PROMPT_THREAD_WINDOW` messages. */
export function followUpThreadSoFar(followUps: Reply[]): string {
  return followUps.slice(-PROMPT_THREAD_WINDOW).map(m => `[${m.author}] ${m.text}`).join('\n')
}

/** True when the thread is longer than the prompt window, so the prompt can SAY it
 *  is showing a window. An agent that silently receives a truncated history may
 *  contradict something it said earlier and not know why; one that is told it's
 *  seeing the last N can go read the rest off GET /api/notices. */
export function isThreadWindowed(followUps: Reply[]): boolean {
  return followUps.length > PROMPT_THREAD_WINDOW
}

/** Build the follow-up delivery prompt. `notice` must already carry the appended
 *  question as the last entry in `followUps`. `guidance` is the preset's agent-only
 *  instruction (absent for a freeform question). */
export function followUpPromptText(notice: Notice, guidance: string | undefined, origin: string): string {
  const thread = notice.followUps ?? []
  const question = thread[thread.length - 1]?.text ?? ''

  const lines: string[] = [
    `The user asked a follow-up about your Roundup notice "${notice.headline}" (notice ${notice.id}).`,
    '',
    `Their question: ${question}`,
  ]

  if (guidance) {
    lines.push('', `What they are asking for: ${guidance}`)
  }

  if (thread.length > 1) {
    lines.push(
      '',
      isThreadWindowed(thread)
        ? `The thread so far (the last ${PROMPT_THREAD_WINDOW} of ${thread.length} messages — ` +
          `read the full thread on GET /api/notices if you need it):`
        : 'The thread so far:',
      followUpThreadSoFar(thread),
    )
  }

  lines.push(
    '',
    'Do BOTH of these — they are not alternatives:',
    '',
    '1. REPLY on the thread so they get an answer where they asked:',
    `curl -s -X POST '${origin}/api/notices/${notice.id}/replies' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"author":"agent","text":"YOUR ANSWER"}'`,
    '',
    '2. AMEND the notice whenever the answer improves it — which is most of the time.',
    'If your reply contains anything a fresh reader of the board would need, it belongs',
    'in the notice body, not only in the thread:',
    `curl -s -X PATCH '${origin}/api/notices/${notice.id}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"content": { ...revised A2UI content... }}'`,
    '',
    'A thread that holds the real explanation while the card still says the old thing',
    'is the failure mode. The thread is the conversation; the notice is the record.',
    'Keep the reply concise — the depth goes in the amended notice.',
  )

  return lines.join('\n')
}
