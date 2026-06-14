// Shared prompt fragments so the agent's reply curl is byte-identical whether the
// pin lives on a shell widget or a self-rendered browser widget. The host appends
// these to the per-widget "where" descriptor it already builds.
import { threadMessages, type Pin } from '../domain/pinSet'

/** The instruction block telling the agent exactly how to reply onto the note. */
export function replyInstructions(noteId: string, origin: string): string {
  return [
    'Reply to this note by running exactly:',
    `curl -s -X POST '${origin}/api/notes/${noteId}/replies' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"text":"YOUR REPLY"}'`,
    'Your reply appears in the thread on the note. Keep it concise.',
  ].join('\n')
}

/** The thread rendered for a follow-up re-prompt: one line per message. */
export function threadSoFar(pin: Pin): string {
  return threadMessages(pin).map(m => `[${m.author}] ${m.text}`).join('\n')
}
