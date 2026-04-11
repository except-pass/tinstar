import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ContextCategory {
  name: string
  tokens: number
  percentage: number
}

export interface ContextData {
  categories: ContextCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold: number | null
}

/* ------------------------------------------------------------------ */
/*  Concurrency guard + TTL cache                                      */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  data: ContextData
  ts: number
}

const CACHE_TTL_MS = 30_000
const SIDECAR_TIMEOUT_MS = 45_000

const inflightMap = new Map<string, Promise<ContextData>>()
const cacheMap = new Map<string, CacheEntry>()

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function getDetailedUsage(conversationId: string): Promise<ContextData> {
  // Return cached if fresh
  const cached = cacheMap.get(conversationId)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  // Return in-flight promise if one exists (concurrency guard)
  const inflight = inflightMap.get(conversationId)
  if (inflight) return inflight

  const promise = spawnSidecar(conversationId)
  inflightMap.set(conversationId, promise)

  try {
    const data = await promise
    cacheMap.set(conversationId, { data, ts: Date.now() })
    return data
  } finally {
    inflightMap.delete(conversationId)
  }
}

/* ------------------------------------------------------------------ */
/*  Sidecar                                                            */
/* ------------------------------------------------------------------ */

function spawnSidecar(conversationId: string): Promise<ContextData> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child?.kill('SIGKILL')
        reject(new Error('Sidecar timed out'))
      }
    }, SIDECAR_TIMEOUT_MS)

    child = spawn('claude', [
      '--print',
      '--resume', conversationId,
      '--fork-session',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '1',
      '--model', 'claude-haiku-4-5-20251001',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Send control request + throwaway user message (needed to flush the control_response)
    const requestId = randomUUID()
    const controlLine = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'get_context_usage' },
    })
    const userLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x' },
      session_id: '',
      parent_tool_use_id: null,
    })

    child.stdin!.write(controlLine + '\n')
    child.stdin!.write(userLine + '\n')
    child.stdin!.end()

    // Parse stdout line-by-line for the control_response
    let buffer = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()! // keep incomplete last line

      for (const line of lines) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'control_response' && parsed.request_id === requestId) {
            settled = true
            clearTimeout(timeout)
            child?.kill('SIGKILL')

            const r = parsed.response?.response
            if (!Array.isArray(r?.categories)) {
              reject(new Error('Control response missing categories'))
              return
            }

            resolve({
              categories: r.categories,
              totalTokens: r.totalTokens ?? 0,
              maxTokens: r.maxTokens ?? 200_000,
              percentage: r.percentage ?? 0,
              model: r.model ?? 'unknown',
              isAutoCompactEnabled: r.isAutoCompactEnabled ?? false,
              autoCompactThreshold: r.autoCompactThreshold ?? null,
            })
          }
        } catch {
          // Not JSON or not our message — skip
        }
      }
    })

    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString()
    })

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`Sidecar process error: ${err.message}`))
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        const msg = stderr.trim() ? `Sidecar exited ${code}: ${stderr.slice(0, 200)}` : `Sidecar exited with code ${code}`
        reject(new Error(msg))
      }
    })
  })
}
