import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RecapEntry } from '../../types'
import { randomUUID } from 'node:crypto'

/** Encode a workdir path the same way Claude Code does for project directories */
function encodeWorkdir(workdir: string): string {
  // Claude Code encodes the path by replacing / with - and removing leading -
  return workdir.replace(/\//g, '-').replace(/^-/, '')
}

/** Build the JSONL transcript path for a given conversation */
export function getTranscriptPath(workdir: string, conversationId: string): string {
  const encoded = encodeWorkdir(workdir)
  return join(homedir(), '.claude', 'projects', encoded, `${conversationId}.jsonl`)
}

// Track last read position per session
const offsets = new Map<string, number>()

/** Parse new transcript entries since last read, returns RecapEntry objects */
export function parseNewEntries(sessionName: string, workdir: string, conversationId: string): RecapEntry[] {
  const path = getTranscriptPath(workdir, conversationId)
  if (!existsSync(path)) return []

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())
  const lastOffset = offsets.get(sessionName) ?? 0
  const newLines = lines.slice(lastOffset)

  if (newLines.length === 0) return []

  const entries: RecapEntry[] = []

  for (const line of newLines) {
    try {
      const obj = JSON.parse(line)
      const entry = extractEntry(obj)
      if (entry) entries.push(entry)
    } catch {
      // Skip malformed lines
    }
  }

  offsets.set(sessionName, lines.length)
  return entries
}

/** Reset offset tracking for a session */
export function resetOffset(sessionName: string): void {
  offsets.delete(sessionName)
}

function extractEntry(obj: Record<string, unknown>): RecapEntry | null {
  const type = obj.type as string
  if (!type) return null

  if (type === 'user') {
    return extractUserEntry(obj)
  }
  if (type === 'assistant') {
    return extractAssistantEntry(obj)
  }
  // Skip progress, file-history-snapshot, etc.
  return null
}

function extractUserEntry(obj: Record<string, unknown>): RecapEntry | null {
  const message = obj.message as Record<string, unknown> | undefined
  if (!message) return null

  const content = message.content
  if (typeof content === 'string') {
    // Skip internal commands
    if (content.startsWith('<local-command-')) return null
    if (!content.trim()) return null
    return {
      id: randomUUID(),
      type: 'user',
      content: content.trim(),
      timestamp: (obj.timestamp as string) ?? new Date().toISOString(),
    }
  }

  // content could be an array (tool_result blocks) — skip these
  if (Array.isArray(content)) {
    // Check if any block is a text block with user content
    const textBlocks = (content as Array<Record<string, unknown>>).filter(
      b => b.type === 'text' && typeof b.text === 'string'
    )
    if (textBlocks.length === 0) return null
    const text = textBlocks.map(b => b.text as string).join('\n').trim()
    if (!text || text.startsWith('<local-command-')) return null
    return {
      id: randomUUID(),
      type: 'user',
      content: text,
      timestamp: (obj.timestamp as string) ?? new Date().toISOString(),
    }
  }

  return null
}

function extractAssistantEntry(obj: Record<string, unknown>): RecapEntry | null {
  const message = obj.message as Record<string, unknown> | undefined
  if (!message) return null

  const content = message.content
  if (!Array.isArray(content)) return null

  // Extract only text blocks, skip tool_use, thinking, etc.
  const textBlocks = (content as Array<Record<string, unknown>>).filter(
    b => b.type === 'text' && typeof b.text === 'string'
  )

  if (textBlocks.length === 0) return null
  const text = textBlocks.map(b => b.text as string).join('\n').trim()
  if (!text) return null

  return {
    id: randomUUID(),
    type: 'agent',
    content: text,
    timestamp: (obj.timestamp as string) ?? new Date().toISOString(),
  }
}
