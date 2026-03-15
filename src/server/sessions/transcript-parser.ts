import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RecapEntry } from '../../types'
import { randomUUID } from 'node:crypto'

/** Encode a workdir path the same way Claude Code does for project directories */
function encodeWorkdir(workdir: string): string {
  // Claude Code encodes the path by replacing / with - (keeps the leading dash)
  return workdir.replace(/\//g, '-')
}

/** Build the JSONL transcript path for a given conversation */
export function getTranscriptPath(workdir: string, conversationId: string, stateDir?: string): string {
  const encoded = encodeWorkdir(workdir)
  // Docker sessions mount claude-state into a session-specific dir
  const base = stateDir ?? join(homedir(), '.claude', 'projects')
  return join(base, encoded, `${conversationId}.jsonl`)
}

// Track last read position per session
const offsets = new Map<string, number>()

/**
 * Parse transcript into recap entries: user prompt + last assistant response per turn.
 * Intermediate assistant messages (thinking-out-loud, tool-call narration) are skipped.
 */
export function parseNewEntries(sessionName: string, workdir: string, conversationId: string, stateDir?: string): RecapEntry[] {
  const path = getTranscriptPath(workdir, conversationId, stateDir)
  if (!existsSync(path)) return []

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())
  const lastOffset = offsets.get(sessionName) ?? 0
  const newLines = lines.slice(lastOffset)

  if (newLines.length === 0) return []

  // Parse all new lines into typed records
  const records: Array<{ type: 'user' | 'agent'; text: string; timestamp: string }> = []
  for (const line of newLines) {
    try {
      const obj = JSON.parse(line)
      const rec = extractRecord(obj)
      if (rec) records.push(rec)
    } catch {
      // Skip malformed lines
    }
  }

  // Group into turns: each user message starts a new turn.
  // Keep the user prompt and only the LAST assistant text before the next user message.
  const entries: RecapEntry[] = []
  let lastAgent: { text: string; timestamp: string } | null = null

  for (const rec of records) {
    if (rec.type === 'user') {
      // Flush previous turn's last agent response
      if (lastAgent) {
        entries.push({ id: randomUUID(), type: 'agent', content: lastAgent.text, timestamp: lastAgent.timestamp })
        lastAgent = null
      }
      entries.push({ id: randomUUID(), type: 'user', content: rec.text, timestamp: rec.timestamp })
    } else {
      // Keep overwriting — we only want the last one
      lastAgent = { text: rec.text, timestamp: rec.timestamp }
    }
  }

  // Flush trailing agent response
  if (lastAgent) {
    entries.push({ id: randomUUID(), type: 'agent', content: lastAgent.text, timestamp: lastAgent.timestamp })
  }

  offsets.set(sessionName, lines.length)
  return entries
}

/** Reset offset tracking for a session */
export function resetOffset(sessionName: string): void {
  offsets.delete(sessionName)
}

// --- Record extraction ---

function extractRecord(obj: Record<string, unknown>): { type: 'user' | 'agent'; text: string; timestamp: string } | null {
  const type = obj.type as string
  if (!type) return null

  const timestamp = (obj.timestamp as string) ?? new Date().toISOString()

  if (type === 'user') {
    const text = extractUserText(obj)
    return text ? { type: 'user', text, timestamp } : null
  }
  if (type === 'assistant') {
    const text = extractAssistantText(obj)
    return text ? { type: 'agent', text, timestamp } : null
  }
  return null
}

function extractUserText(obj: Record<string, unknown>): string | null {
  const message = obj.message as Record<string, unknown> | undefined
  if (!message) return null

  const content = message.content
  if (typeof content === 'string') {
    if (content.startsWith('<local-command-')) return null
    const trimmed = content.trim()
    return trimmed || null
  }

  if (Array.isArray(content)) {
    // tool_result arrays aren't real user messages — skip unless they contain text blocks
    const textBlocks = (content as Array<Record<string, unknown>>).filter(
      b => b.type === 'text' && typeof b.text === 'string'
    )
    if (textBlocks.length === 0) return null
    const text = textBlocks.map(b => b.text as string).join('\n').trim()
    if (!text || text.startsWith('<local-command-')) return null
    // Skip system/skill injections (long auto-generated content)
    if (text.startsWith('Base directory for this skill:')) return null
    return text
  }

  return null
}

function extractAssistantText(obj: Record<string, unknown>): string | null {
  const message = obj.message as Record<string, unknown> | undefined
  if (!message) return null

  const content = message.content
  if (!Array.isArray(content)) return null

  const textBlocks = (content as Array<Record<string, unknown>>).filter(
    b => b.type === 'text' && typeof b.text === 'string'
  )

  if (textBlocks.length === 0) return null
  const text = textBlocks.map(b => b.text as string).join('\n').trim()
  return text || null
}
