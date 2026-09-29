import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttentionCard } from './attention'
import { runHomeScript } from './inbox'

const CAPTAIN_TEXT = 'Dismissed by the operator from Tin Star.'
const WORKER_TEXT = 'The operator dismissed this decision from Tin Star; it no longer needs an answer. Carry on without it.'
// fm-send bounds one remote attempt at 30s. A shorter kill would cut off a close still inside that bound.
const CLOSE_TIMEOUT_MS = 30_000

export type DirectDismiss = { dismissed: true } | { dismissed: false; error: string }

function scriptError(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || 'The decision was not closed.'
}

/** Closes one classified decision by running that home's own First Mate script. Exit 0 is the only success. */
export async function dismissDirect(home: string, card: AttentionCard): Promise<DirectDismiss> {
  try {
    if (card.dismissal === 'captain-hold' && card.holdId) {
      const dir = await mkdtemp(join(tmpdir(), 'tinstar-dismiss-'))
      const file = join(dir, 'decision')
      try {
        await writeFile(file, CAPTAIN_TEXT, { mode: 0o600 })
        const result = await runHomeScript(home, 'fm-captain-hold.sh', ['answer', card.holdId, '--decision-file', file], undefined, CLOSE_TIMEOUT_MS)
        return result.code === 0 ? { dismissed: true } : { dismissed: false, error: scriptError(result) }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    if (card.dismissal === 'resolve-key' && card.taskId && card.decisionKey) {
      const result = await runHomeScript(home, 'fm-send.sh', [card.taskId, '--resolve-key', card.decisionKey, WORKER_TEXT], undefined, CLOSE_TIMEOUT_MS)
      return result.code === 0 ? { dismissed: true } : { dismissed: false, error: scriptError(result) }
    }
  } catch (error) {
    return { dismissed: false, error: (error as Error).message }
  }
  return { dismissed: false, error: 'This decision has no direct close.' }
}
