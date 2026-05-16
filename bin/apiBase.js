// bin/apiBase.js — resolve the Tinstar API base URL for CLI commands.
// Precedence: TINSTAR_API_BASE env > server.host/server.port files > localhost:5273.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from './configRoot.js'

const DEFAULT_PORT = 5273
const DEFAULT_HOST = 'localhost'

function readTrim(path) {
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
}

export function getApiBase() {
  const envBase = process.env.TINSTAR_API_BASE
  if (envBase && envBase.length > 0) return envBase.replace(/\/$/, '')

  const root = getConfigRoot()
  const portFile = join(root, 'server.port')
  const hostFile = join(root, 'server.host')

  let port = DEFAULT_PORT
  if (existsSync(portFile)) {
    const v = parseInt(readTrim(portFile), 10)
    if (Number.isFinite(v) && v > 0) port = v
  }

  let host = DEFAULT_HOST
  if (existsSync(hostFile)) {
    const v = readTrim(hostFile)
    if (v) host = v
  }

  return `http://${host}:${port}`
}
