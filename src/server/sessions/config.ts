import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// --- Types ---

export interface ImageProfile {
  name: string
  image: string
  home?: string
}

export type AdapterType = 'claude' | 'codex' | 'generic'

export interface CliTemplate {
  name: string
  icon?: string
  adapter?: AdapterType
  startCmd: string
  resumeCmd: string
}

export interface TinstarConfig {
  container: { prefix: string; defaultImage: string; home: string }
  profiles: ImageProfile[]
  cliTemplates: CliTemplate[]
  editor: string
  ports: { ttyd: number; hostStart: number }
  dirs: { root: string; secrets: string; sessions: string }
  files: { config: string; projects: string }
  git: {
    taskMarkerRegex: string
    reconciliationRepos: string[]
    reconciliationBranchScope: string
  }
  nats: {
    channelServerPackage: string  // npm package or github:user/repo
    bunPath: string
  }
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

// --- Default CLI templates ---

const DEFAULT_CLI_TEMPLATES: CliTemplate[] = [
  {
    name: 'Claude (auto)',
    icon: '✦',
    adapter: 'claude',
    startCmd: 'claude --dangerously-skip-permissions --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --resume {sessionId}',
  },
  {
    name: 'Claude (interactive)',
    icon: '✦',
    adapter: 'claude',
    startCmd: 'claude --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --resume {sessionId}',
  },
  {
    name: 'Claude (multi-agent)',
    icon: '⚡',
    adapter: 'claude',
    startCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --resume {sessionId}',
  },
  {
    name: 'Codex (full auto)',
    icon: '◎',
    adapter: 'codex',
    startCmd: 'codex --full-auto -- {prompt}',
    resumeCmd: 'codex resume --last --full-auto',
  },
  {
    name: 'Cursor Agent',
    icon: '◆',
    adapter: 'generic',
    startCmd: 'agent --yolo -- {prompt}',
    resumeCmd: 'agent resume',
  },
]

// --- Base config (hardcoded defaults) ---

const BASE_CONFIG = {
  container: {
    prefix: 'tinstar-',
    defaultImage: '',
    home: '/home/tinstar',
  },
  ports: {
    ttyd: 7681,
    hostStart: 8681,
  },
  git: {
    taskMarkerRegex: '#([A-Za-z0-9_-]+)',
    reconciliationRepos: [],
    reconciliationBranchScope: '*',
  },
  nats: {
    // Default: install from GitHub on first use via `bun x`
    // Override in ~/.config/tinstar/config.json for local dev
    channelServerPackage: 'github:except-pass/nats-channel-mcp',
    bunPath: join(homedir(), '.bun/bin/bun'),
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

  // Profiles are replaced wholesale (not deep-merged) — user list wins if present
  const profiles: ImageProfile[] = Array.isArray(userConfig.profiles)
    ? userConfig.profiles as ImageProfile[]
    : []

  // CLI templates: user list extends defaults (user can override by name)
  const userTemplates = Array.isArray(userConfig.cliTemplates)
    ? userConfig.cliTemplates as CliTemplate[]
    : []
  const cliTemplates = [...DEFAULT_CLI_TEMPLATES]
  for (const ut of userTemplates) {
    const idx = cliTemplates.findIndex(t => t.name === ut.name)
    if (idx >= 0) cliTemplates[idx] = ut
    else cliTemplates.push(ut)
  }

  const editor = typeof userConfig.editor === 'string' ? userConfig.editor : 'cursor {{path}}'

  const config: TinstarConfig = {
    container: merged.container,
    profiles,
    cliTemplates,
    editor,
    ports: merged.ports,
    dirs: {
      root: rootDir,
      secrets: join(rootDir, '.secrets'),
      sessions: join(rootDir, 'sessions'),
    },
    files: {
      config: userConfigPath,
      projects: join(rootDir, 'projects.json'),
    },
    git: {
      taskMarkerRegex: typeof userConfig.taskMarkerRegex === 'string'
        ? userConfig.taskMarkerRegex
        : merged.git.taskMarkerRegex,
      reconciliationRepos: Array.isArray(userConfig.reconciliationRepos)
        ? userConfig.reconciliationRepos as string[]
        : merged.git.reconciliationRepos,
      reconciliationBranchScope: typeof userConfig.reconciliationBranchScope === 'string'
        ? userConfig.reconciliationBranchScope
        : merged.git.reconciliationBranchScope,
    },
    nats: {
      channelServerPackage: typeof (userConfig.nats as Record<string, unknown>)?.channelServerPackage === 'string'
        ? (userConfig.nats as Record<string, string>).channelServerPackage
        : merged.nats.channelServerPackage,
      bunPath: typeof (userConfig.nats as Record<string, unknown>)?.bunPath === 'string'
        ? (userConfig.nats as Record<string, string>).bunPath
        : merged.nats.bunPath,
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

  // Copy start-ttyd.sh to config dir so it can be mounted into any container
  const scriptDest = join(config.dirs.root, 'start-ttyd.sh')
  try {
    const scriptSrc = join(new URL('.', import.meta.url).pathname, 'scripts', 'start-ttyd.sh')
    const content = readFileSync(scriptSrc, 'utf-8')
    writeFileSync(scriptDest, content, { mode: 0o755 })
  } catch {
    // Script may already exist from a previous run, or source not found in production
  }
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
