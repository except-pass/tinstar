import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getConfigRoot } from '../configRoot'

// --- Types ---

export type AdapterType = 'claude' | 'codex' | 'generic'

export interface CliTemplate {
  name: string
  icon?: string
  adapter?: AdapterType
  telemetry?: boolean
  startCmd: string
  resumeCmd: string
}

export interface TinstarConfig {
  /** Prefix applied to tmux session names (e.g. `tinstar-mysession`). */
  sessions: { prefix: string }
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
    /**
     * Pass --jetstream to the channel-server. Enables durable consumers
     * (buffered messages survive short pauses + reconnect) and the
     * `replay` MCP tool. Requires nats-server to be running with -js.
     * See nats-channel-mcp's README "JetStream Mode" section.
     */
    jetstream: boolean
    /**
     * When true, the health monitor auto-recovers a session whose control
     * socket stays orphaned past ORPHAN_RECOVER_FAILS consecutive probes — it
     * SIGTERMs the channel-server so Claude relaunches it. Off by default:
     * recovery briefly interrupts the agent's MCP, so opt in deliberately. The
     * manual Saloon reconnect button works regardless of this flag.
     */
    autoRecoverOrphans: boolean
  }
  /** Max upload size in bytes for file-upload route. Must be >= 1 MB. */
  uploadMaxBytes: number
  /** UI preferences. Client-controlled; server only stores. */
  ui: {
    promptComposerDefault: boolean
    showEmptyEntities: boolean
    layouts: Record<string, unknown>
    telemetryPanels: {
      cost: boolean
      tokens: boolean
      cacheHit: boolean
      duty: boolean
      turnLength: boolean
    }
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

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
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
    name: 'Claude (multi-agent)',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    startCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --resume {sessionId}',
  },
  {
    name: 'Claude (auto)',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    startCmd: 'claude --dangerously-skip-permissions --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --resume {sessionId}',
  },
  {
    name: 'Claude (interactive)',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    startCmd: 'claude --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --resume {sessionId}',
  },
  {
    name: 'Codex (full auto)',
    icon: '/agent-icons/openai.svg',
    adapter: 'codex',
    startCmd: 'codex --full-auto -- {prompt}',
    resumeCmd: 'codex resume --last --full-auto',
  },
  {
    // Dedicated template for the in-app marshal (the canvas-sidebar copilot).
    // Defaults to Haiku for snappy, low-cost responses; users can override by
    // dropping a same-named entry into ~/.config/tinstar/config.json's
    // cliTemplates array.
    name: 'Marshal',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    // The marshal hand carries a persona (see hands/builtins/index.ts) that
    // gets injected via `--append-system-prompt {agentPrompt}` — so the persona
    // is the MAIN conversation's system prompt (it IS the marshal), not a
    // subagent definition. The flag is process-level, so it survives `/clear`.
    // The trailing {prompt} is the one-shot intro instruction the marshal
    // sees as its first user message.
    //
    // Available persona placeholders:
    //   {agentName}, {agentDescription}, {agentPrompt}, {agentJson}
    // {agentJson}/--agents is for spawning the persona as a Task subagent —
    // that's NOT what we want for the main marshal conversation.
    startCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --model haiku --append-system-prompt {agentPrompt} --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --model haiku --append-system-prompt {agentPrompt} --resume {sessionId}',
  },
  {
    name: 'Cursor Agent',
    icon: '/agent-icons/cursor.svg',
    adapter: 'generic',
    startCmd: 'agent --yolo -- {prompt}',
    resumeCmd: 'agent resume',
  },
  {
    name: 'shell',
    adapter: 'generic',
    telemetry: false,
    startCmd: ':',
    resumeCmd: ':',
  },
]

// --- Base config (hardcoded defaults) ---

export const BASE_CONFIG = {
  sessions: {
    prefix: 'tinstar-',
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
    // Off by default; requires nats-server -js
    jetstream: false,
    // Off by default; auto-recovery interrupts a live agent's MCP.
    autoRecoverOrphans: false,
  },
  uploadMaxBytes: 100 * 1024 * 1024,
  ui: {
    promptComposerDefault: false,
    showEmptyEntities: true,
    layouts: {},
    telemetryPanels: {
      cost: true,
      tokens: true,
      cacheHit: false,
      duty: true,
      turnLength: true,
    },
  },
}

// --- Public API ---

export function loadConfig(overrides?: { _rootDir?: string }): TinstarConfig {
  const rootDir = overrides?._rootDir ?? getConfigRoot()

  // Read optional user overrides
  const userConfigPath = join(rootDir, 'config.json')
  let userConfig: Record<string, unknown> = {}
  try {
    userConfig = JSON.parse(readFileSync(userConfigPath, 'utf-8'))
  } catch {
    // No user config — fine
  }

  const merged = deepMerge(BASE_CONFIG as unknown as Record<string, unknown>, userConfig) as unknown as typeof BASE_CONFIG

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
    sessions: merged.sessions,
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
        ? (userConfig.nats as Record<string, string>).channelServerPackage!
        : merged.nats.channelServerPackage,
      bunPath: typeof (userConfig.nats as Record<string, unknown>)?.bunPath === 'string'
        ? (userConfig.nats as Record<string, string>).bunPath!
        : merged.nats.bunPath,
      jetstream: typeof (userConfig.nats as Record<string, unknown>)?.jetstream === 'boolean'
        ? (userConfig.nats as Record<string, boolean>).jetstream!
        : merged.nats.jetstream,
      autoRecoverOrphans: typeof (userConfig.nats as Record<string, unknown>)?.autoRecoverOrphans === 'boolean'
        ? (userConfig.nats as Record<string, boolean>).autoRecoverOrphans!
        : merged.nats.autoRecoverOrphans,
    },
    uploadMaxBytes: merged.uploadMaxBytes,
    ui: merged.ui,
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

/** Returns the user's on-disk config deep-merged over defaults. Source of truth for `GET /api/config`. */
export function loadConfigMerged(configRoot?: string): Record<string, unknown> {
  const root = configRoot ?? getConfigRoot()
  const path = join(root, 'config.json')
  let userConfig: Record<string, unknown> = {}
  try { userConfig = JSON.parse(readFileSync(path, 'utf-8')) } catch { /* defaults only */ }
  return deepMerge(BASE_CONFIG as unknown as Record<string, unknown>, userConfig)
}
