import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerPrefs {
  uploadMaxBytes: number
}

export const DEFAULT_SERVER_PREFS: ServerPrefs = {
  uploadMaxBytes: 100 * 1024 * 1024, // 100 MB
}

const MIN_UPLOAD_BYTES = 1 * 1024 * 1024 // 1 MB

function fileFor(configRoot: string): string {
  return join(configRoot, 'server-prefs.json')
}

export function loadServerPrefs(configRoot: string): ServerPrefs {
  const path = fileFor(configRoot)
  if (!existsSync(path)) return { ...DEFAULT_SERVER_PREFS }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { ...DEFAULT_SERVER_PREFS, ...raw }
  } catch {
    return { ...DEFAULT_SERVER_PREFS }
  }
}

export function saveServerPrefs(configRoot: string, patch: Partial<ServerPrefs>): ServerPrefs {
  if (patch.uploadMaxBytes !== undefined) {
    if (!Number.isInteger(patch.uploadMaxBytes) || patch.uploadMaxBytes < MIN_UPLOAD_BYTES) {
      throw new Error(`uploadMaxBytes must be an integer >= ${MIN_UPLOAD_BYTES}`)
    }
  }
  mkdirSync(configRoot, { recursive: true })
  const merged = { ...loadServerPrefs(configRoot), ...patch }
  writeFileSync(fileFor(configRoot), JSON.stringify(merged, null, 2))
  return merged
}
