// The prompt an agent receives when the user answers (or dissents from) one of
// its Roundup notices (KTD1/U1). This reuses the notes/pins delivery pattern:
// the server bakes a human-readable description of the answer into a prompt and
// submits it to the posting session (notice.runId), mirroring how a note reply
// reaches its agent. The answer is already persisted on the notice before this
// is delivered, so delivery is best-effort — a busy session can also read its
// own notices back over GET /api/notices.
import type { Notice } from '../domain/types'

/** Build the answer-delivery prompt for a notice. `optionLabels` maps the
 *  notice's declared choice option ids → their human labels, so the agent sees
 *  "Ship behind a flag" rather than an opaque id. Returns '' if the notice has
 *  no answer (nothing to deliver). */
export function answerPromptText(notice: Notice, optionLabels: Map<string, string>): string {
  const answer = notice.answer
  if (!answer) return ''

  const lines: string[] = []
  if (answer.dissent) {
    lines.push(`The user DISAGREED with your FYI notice "${notice.headline}" (notice ${notice.id}).`)
  } else {
    lines.push(`The user answered your Roundup notice "${notice.headline}" (notice ${notice.id}).`)
  }

  if (answer.choices.length > 0) {
    const chosen = answer.choices.map(id => optionLabels.get(id) ?? id)
    lines.push(`They chose: ${chosen.join(', ')}`)
  }
  if (answer.text) {
    lines.push(answer.dissent ? `Their objection: ${answer.text}` : `They added: ${answer.text}`)
  }

  lines.push(
    `Act on this answer, then keep the board honest: amend the notice (PATCH /api/notices/${notice.id}) ` +
    `or pull it down (DELETE /api/notices/${notice.id}) once it is resolved.`,
  )
  return lines.join('\n')
}
