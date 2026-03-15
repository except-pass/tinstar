import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getSession, setConversationId } from './session'

/**
 * Find the most recently modified .jsonl conversation file by walking the
 * Claude state directory tree. Returns the conversation ID (filename without
 * .jsonl extension) or null.
 */
export function detectConversationId(claudeStateDir: string): string | null {
  try {
    return findNewestConversationId(claudeStateDir)
  } catch {
    return null
  }
}

export function findNewestConversationId(baseDir: string): string | null {
  let newest: string | null = null
  let newestMtime = 0

  function walk(dir: string): void {
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' as const })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const { mtimeMs } = statSync(fullPath)
          if (mtimeMs > newestMtime) {
            newestMtime = mtimeMs
            newest = entry.name.replace('.jsonl', '')
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(baseDir)
  return newest
}

/**
 * Ensure a session has a conversation ID for --resume.
 * Checks the session record first, then scans the claude state dir.
 */
export function ensureResumeReady(
  sessionsDir: string,
  sessionName: string,
  claudeStateDir: string,
): string | null {
  const session = getSession(sessionsDir, sessionName)
  if (!session) return null

  // Already have a conversation ID
  if (session.conversation?.id) {
    return session.conversation.id
  }

  // Try to detect from claude state files
  const detected = detectConversationId(claudeStateDir)
  if (detected) {
    setConversationId(sessionsDir, sessionName, detected)
    return detected
  }

  return null
}
