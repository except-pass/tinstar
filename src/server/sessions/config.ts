import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// --- Types ---

export interface TinstarConfig {
  container: { prefix: string; defaultImage: string; home: string }
  ports: { ttyd: number; hostStart: number }
  caddy: { listenPort: number; adminPort: number }
  dirs: { root: string; secrets: string; sessions: string }
  files: { config: string; projects: string }
}

// --- Helpers ---

function deepFreeze<T>(obj: T): T {
  Object.freeze(obj)
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val)
    }
  }
  return obj
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv)
      && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      result[key] = sv
    }
  }
  return result
}

// --- Base config (hardcoded defaults) ---

const BASE_CONFIG = {
  container: {
    prefix: 'tinstar-',
    defaultImage: 'tinstar',
    home: '/home/tinstar',
  },
  ports: {
    ttyd: 7681,
    hostStart: 8681,
  },
  caddy: {
    listenPort: 8088,
    adminPort: 2019,
  },
}

// --- Public API ---

export function loadConfig(overrides?: { _rootDir?: string }): TinstarConfig {
  const rootDir = overrides?._rootDir ?? join(homedir(), '.config', 'tinstar')

  // Read optional user overrides
  const userConfigPath = join(rootDir, 'config.json')
  let userConfig: Record<string, unknown> = {}
  try {
    userConfig = JSON.parse(readFileSync(userConfigPath, 'utf-8'))
  } catch {
    // No user config — fine
  }

  const merged = deepMerge(BASE_CONFIG as unknown as Record<string, unknown>, userConfig) as unknown as typeof BASE_CONFIG

  const config: TinstarConfig = {
    container: merged.container,
    ports: merged.ports,
    caddy: (merged as unknown as { caddy?: TinstarConfig['caddy'] }).caddy ?? { listenPort: 8088, adminPort: 2019 },
    dirs: {
      root: rootDir,
      secrets: join(rootDir, '.secrets'),
      sessions: join(rootDir, 'sessions'),
    },
    files: {
      config: userConfigPath,
      projects: join(rootDir, 'projects.json'),
    },
  }

  return deepFreeze(config)
}

export function loadSecrets(secretsDir: string): Record<string, string> {
  const secrets: Record<string, string> = {}
  let entries: string[]
  try {
    entries = readdirSync(secretsDir)
  } catch {
    return secrets
  }
  for (const name of entries) {
    try {
      secrets[name] = readFileSync(join(secretsDir, name), 'utf-8').trim()
    } catch {
      // Skip unreadable files
    }
  }
  return secrets
}

export function ensureDirs(config: TinstarConfig): void {
  mkdirSync(config.dirs.root, { recursive: true })
  mkdirSync(config.dirs.secrets, { recursive: true })
  mkdirSync(config.dirs.sessions, { recursive: true })
}

export function loadActiveSpaceId(rootDir: string): string | null {
  try {
    const raw = readFileSync(join(rootDir, 'config.json'), 'utf-8')
    const data = JSON.parse(raw)
    return data.activeSpaceId ?? null
  } catch {
    return null
  }
}

export function saveActiveSpaceId(rootDir: string, spaceId: string): void {
  const configPath = join(rootDir, 'config.json')
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch { /* no existing config */ }
  data.activeSpaceId = spaceId
  writeFileSync(configPath, JSON.stringify(data, null, 2))
}
