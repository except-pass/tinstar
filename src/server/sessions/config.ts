import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getConfigRoot } from '../configRoot'
import { log } from '../logger'
import type { ErrorCode } from '../../domain/api'

// --- Types ---

/**
 * Open provider ID resolved through ProviderAdapterRegistry. The built-ins are
 * claude/codex/generic, but adding a provider must not require widening a union.
 */
export type AdapterType = string

/**
 * A named, explicit range of ttyd ports (plan U6).
 *
 * Explicit rather than "100 from a start offset", because U6 gives autonomous
 * refresh workers their OWN slice of the port space and the two slices have to be
 * provably disjoint. A count baked into `findPort` could not express that: both
 * callers would scan the same 100 ports, and a trigger fan-out could take the port
 * a user's `POST /api/sessions` was about to claim.
 *
 * Declared here rather than beside `findPort` only to keep the import graph
 * one-way — `tmux.ts` already imports this module, and the reverse would be a
 * cycle.
 */
export interface PortWindow {
  /** Stable name — what an overlap refusal names, and how `findPort` recognises
   *  the interactive window without being handed its bounds a second time. */
  label: string
  start: number
  /** How many consecutive ports the window covers. */
  count: number
}

/** True when two windows share at least one port. */
export function portWindowsOverlap(a: PortWindow, b: PortWindow): boolean {
  return a.start <= b.start + b.count - 1 && b.start <= a.start + a.count - 1
}

export interface CliTemplate {
  /**
   * Stable reference stored by sessions, entity settings, and hand definitions.
   * The display name is deliberately not an identity and may be renamed.
   */
  id: string
  name: string
  icon?: string
  adapter?: AdapterType
  telemetry?: boolean
  startCmd: string
  resumeCmd: string
}

export function isCliTemplate(entry: unknown): entry is CliTemplate {
  if (!entry || typeof entry !== 'object') return false
  const template = entry as Partial<CliTemplate>
  return typeof template.id === 'string'
    && template.id.length > 0
    && typeof template.name === 'string'
    && typeof template.startCmd === 'string'
    && typeof template.resumeCmd === 'string'
}

export interface TinstarConfig {
  /** Prefix applied to tmux session names (e.g. `tinstar-mysession`). */
  sessions: { prefix: string }
  cliTemplates: CliTemplate[]
  editor: string
  /** ttyd port allocation. `hostStart`/`hostCount` is the window user-initiated
   *  sessions draw from; `refreshStart`/`refreshCount` is the DISJOINT window
   *  autonomous refresh workers draw from (plan U6). Keeping them apart is what
   *  makes a user session unstarvable by background refresh work. */
  ports: { ttyd: number; hostStart: number; hostCount: number; refreshStart: number; refreshCount: number }
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
      timeline: boolean
    }
    /** S/M/L quick-resize presets. Shape mirrors widgetSizePresets.ts on the client. */
    widgetSizePresets: {
      small: number
      medium: number
      large: number
      defaultAspect: number
      aspectByType: Record<string, number>
    }
  }
  /**
   * Switchboard per-session override guard (Phase 2 Step 6). Gates the per-session
   * model/token override behind explicit configuration — the override is FAIL-CLOSED
   * unless permitted here. Absent ⇒ defaults (no models allowed, token override off),
   * so a stray override is rejected at launch rather than silently honored.
   */
  switchboard: {
    /** Models permitted for a per-session `--model` override. A model override not
     *  in this list is rejected at launch. Empty ⇒ model override disabled. */
    allowedModels: string[]
    /** Master switch for the per-session OAuth token override. False ⇒ any token
     *  override is rejected at launch (the auth-sensitive default). */
    allowTokenOverride: boolean
  }
  /**
   * The Slate's code-spawned surface authors. When a surface carries a self-contained
   * `refresh` recipe, refreshing it spawns a fresh one-shot author (a headless child)
   * instead of nudging the run's single main agent — see src/server/sessions/surfaceAuthor.ts.
   */
  slate: {
    author: {
      /** Master kill switch for the spike. False ⇒ every refresh falls back to the
       *  main-agent path (deliverSlatePrompt), disabling code-spawned authors with no
       *  code revert. */
      enabled: boolean
      /** Model the one-shot author runs on. Capable by default — a headless author
       *  wanders on a too-weak model; tune toward cheaper/faster once quality holds. */
      model: string
      /** Hard timeout (ms) after which a wandering/hung author child is killed. */
      timeoutMs: number
    }
  }
  /**
   * The durable trigger and refresh engine (plan U6). Owns how many autonomous
   * refresh workers may run at once, how long one may take, and how often the
   * coordinator sweeps for due work.
   */
  refresh: {
    /** Master kill switch (plan U6: "Keep a temporary kill switch that falls back
     *  to owner delivery while rollout is incomplete"). False ⇒ the coordinator
     *  still tracks freshness and queues jobs, but every dispatch goes to the
     *  surface's OWNER session rather than launching a background worker. */
    autonomousWorkers: boolean
    /** Fleet-wide cap on CONCURRENTLY RUNNING background refresh workers. Jobs
     *  beyond it stay `queued` and launch nothing.
     *
     *  THE INVARIANT (plan U6): this defaults comfortably below
     *  `ports.refreshCount`, so workers cannot exhaust even their own port slice —
     *  and since that slice is disjoint from the interactive one, an interactive
     *  session is unstarvable at any trigger volume. A config that raises this
     *  above the refresh window size is refused at boot. */
    maxConcurrentWorkers: number
    /** Hard wall-clock bound on one worker before the job is failed and its
     *  session retired. */
    workerTimeoutMs: number
    /** How often the coordinator sweeps: launches due queued work, harvests
     *  finished workers, and re-derives `overdue`. */
    sweepMs: number
    /** Default verification interval for a Surface whose author declared a policy
     *  but no interval. `dueAt` is derived from the last successful verification
     *  plus this. */
    defaultIntervalMs: number
  }
}

/** The ttyd port window user-initiated sessions draw from. */
export function interactivePortWindow(cfg: TinstarConfig): PortWindow {
  return { label: 'interactive', start: cfg.ports.hostStart, count: cfg.ports.hostCount }
}

/** The DISJOINT ttyd port window autonomous refresh workers draw from (plan U6). */
export function refreshPortWindow(cfg: TinstarConfig): PortWindow {
  return { label: 'refresh', start: cfg.ports.refreshStart, count: cfg.ports.refreshCount }
}

/**
 * What is wrong with this config's refresh/port settings, or null.
 *
 * Two checks, and they are the two the plan names as the composed guard: the
 * windows must not overlap, and the worker cap must stay below the refresh
 * window's size. Reported rather than thrown so the caller decides whether a bad
 * user edit degrades the feature or stops the boot.
 */
export function refreshConfigProblem(cfg: TinstarConfig): string | null {
  const interactive = interactivePortWindow(cfg)
  const refresh = refreshPortWindow(cfg)
  if (refresh.count < 1 || interactive.count < 1) {
    return `port windows must cover at least one port each (interactive=${interactive.count}, refresh=${refresh.count})`
  }
  if (portWindowsOverlap(interactive, refresh)) {
    return `ports.refreshStart/refreshCount (${refresh.start}-${refresh.start + refresh.count - 1}) overlaps ` +
      `ports.hostStart/hostCount (${interactive.start}-${interactive.start + interactive.count - 1}); ` +
      'the interactive and refresh port windows must be disjoint'
  }
  if (cfg.refresh.maxConcurrentWorkers < 0) return 'refresh.maxConcurrentWorkers may not be negative'
  if (cfg.refresh.maxConcurrentWorkers >= refresh.count) {
    return `refresh.maxConcurrentWorkers (${cfg.refresh.maxConcurrentWorkers}) must stay below ports.refreshCount ` +
      `(${refresh.count}) — the cap exists so workers cannot exhaust their own port slice`
  }
  return null
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
    id: 'claude-multi-agent',
    name: 'Claude (multi-agent)',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    startCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --resume {sessionId}',
  },
  {
    id: 'claude-auto',
    name: 'Claude (auto)',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    startCmd: 'claude --dangerously-skip-permissions --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --resume {sessionId}',
  },
  {
    id: 'claude-interactive',
    name: 'Claude (interactive)',
    icon: '/agent-icons/claude.svg',
    adapter: 'claude',
    startCmd: 'claude --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --resume {sessionId}',
  },
  {
    id: 'codex-full-auto',
    name: 'Codex (full auto)',
    icon: '/agent-icons/openai.svg',
    adapter: 'codex',
    // --sandbox workspace-write scopes codex to write within the workspace.
    // No --mcp-config/NATS wiring: codex has no such flag (see buildAgentCommand's
    // adapter gate). Approval policy falls to codex's config default (no -a).
    startCmd: 'codex --sandbox workspace-write -- {prompt}',
    resumeCmd: 'codex resume --last --sandbox workspace-write',
  },
  {
    // Dedicated template for the in-app marshal (the canvas-sidebar copilot).
    // Runs on Sonnet — the marshal resolves parents, spawns sessions, and drives
    // the viewport, which needs more reasoning than Haiku reliably gives. Users
    // can override by dropping an entry with this template ID into
    // ~/.config/tinstar/config.json's cliTemplates array.
    id: 'marshal',
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
    startCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --model sonnet --append-system-prompt {agentPrompt} --session-id {sessionId} -- {prompt}',
    resumeCmd: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --model sonnet --append-system-prompt {agentPrompt} --resume {sessionId}',
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    icon: '/agent-icons/cursor.svg',
    adapter: 'generic',
    // Interactive launch: cursor's `agent` shows a one-time workspace-trust
    // modal that --yolo can't bypass. Tinstar pre-seeds cursor's trust marker
    // before launch (see sessions/cursor-trust.ts) so the session starts
    // unattended. NATS is intentionally never wired for this generic adapter —
    // --mcp-config is Claude-only (see buildAgentCommand).
    startCmd: 'agent --yolo -- {prompt}',
    // --yolo (alias for --force, "Run Everything") MUST be repeated on resume.
    // Without it, `agent resume` falls back to the CLI's configured approvalMode
    // (allowlist), which blocks every tool call in a headless session.
    resumeCmd: 'agent --yolo resume',
  },
  {
    id: 'shell',
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
    // Interactive sessions: 8681-8780, exactly the range findPort used to scan.
    hostStart: 8681,
    hostCount: 100,
    // Autonomous refresh workers: 8801-8840. Disjoint from the interactive window
    // with a deliberate gap, so a hand-edited `hostCount` has to be badly wrong
    // before the two touch — and `findPort` refuses it even then.
    refreshStart: 8801,
    refreshCount: 40,
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
      timeline: true,
    },
    // Keep in sync with DEFAULT_WIDGET_SIZE_PRESETS in src/widgets/widgetSizePresets.ts
    widgetSizePresets: {
      small: 0.35,
      medium: 0.6,
      large: 0.85,
      defaultAspect: 1.5,
      aspectByType: {},
    },
  },
  switchboard: {
    allowedModels: [] as string[],
    allowTokenOverride: false,
  },
  slate: {
    author: {
      enabled: true,
      // Capable default: a headless `claude -p` author wanders on a weak model.
      model: 'sonnet',
      timeoutMs: 5 * 60_000,
    },
  },
  refresh: {
    autonomousWorkers: true,
    // Four, against a 40-port refresh window: an order of magnitude of headroom,
    // so the cap — not the port pool — is always what bounds the fleet.
    maxConcurrentWorkers: 4,
    workerTimeoutMs: 10 * 60_000,
    sweepMs: 5_000,
    // SIX HOURS, raised from thirty minutes on measured evidence: across a
    // three-hour session every one of twelve periodic fires returned "no change",
    // and the surface that most needed periodic verification was tracking a number
    // that drifts WEEKLY. A thirty-minute floor against a weekly-drifting answer is
    // roughly three hundred wasted background agents per real change.
    //
    // The periodic tick is an AUDIT of whether a declaration is still complete, not a
    // sampling of the world — the world is sampled by triggers and by witnesses.
    //
    // This is the interval for an author who declared a policy and no number. An
    // author who knows their cadence should say so — `intervalMs: 86400000` for a
    // daily check. A Surface whose sources are all in the repo is already covered by
    // `git-revision` for the moments its answer can change; the deadline is the
    // backstop for the trigger that never arrived, which is why a claim-bearing
    // Surface earns one regardless of where its claims look.
    defaultIntervalMs: 6 * 60 * 60_000,
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

  // CLI templates: user list extends defaults by stable ID. Entries written
  // before IDs were introduced are intentionally ignored: names are labels now,
  // so guessing identity from a mutable name would recreate the rename bug.
  const userTemplates: CliTemplate[] = []
  for (const entry of Array.isArray(userConfig.cliTemplates) ? userConfig.cliTemplates : []) {
    const template = entry as Partial<CliTemplate> | null
    const hasRequiredFields = !!template
      && typeof template === 'object'
      && typeof template.name === 'string'
      && typeof template.startCmd === 'string'
      && typeof template.resumeCmd === 'string'
    if (isCliTemplate(template)) {
      userTemplates.push(template)
      continue
    }
    if (hasRequiredFields) {
      log.warn(
        'config',
        `Ignoring CLI template "${template.name}" because it has no stable "id"; `
        + 'recreate it in Settings to use the new template format. '
        + 'Saving any template removes legacy id-less entries from config.json.',
      )
    }
  }
  const cliTemplates = [...DEFAULT_CLI_TEMPLATES]
  for (const ut of userTemplates) {
    const idx = cliTemplates.findIndex(t => t.id === ut.id)
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
    switchboard: {
      allowedModels: Array.isArray((userConfig.switchboard as Record<string, unknown>)?.allowedModels)
        ? (userConfig.switchboard as Record<string, string[]>).allowedModels!
        : merged.switchboard.allowedModels,
      allowTokenOverride: typeof (userConfig.switchboard as Record<string, unknown>)?.allowTokenOverride === 'boolean'
        ? (userConfig.switchboard as Record<string, boolean>).allowTokenOverride!
        : merged.switchboard.allowTokenOverride,
    },
    // deepMerge already folded any user `slate.author` overrides into merged.slate.
    slate: merged.slate,
    // Same: `refresh` is a flat slice of scalars, so the deep merge is the whole
    // override story. `refreshConfigProblem` is what validates the result.
    refresh: merged.refresh,
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

/**
 * Switchboard per-session token override. Returns the global secrets map UNCHANGED
 * (same reference) when no override is supplied — so the launched env is byte-identical
 * to pre-override behavior. When a per-session token is supplied, returns a shallow copy
 * with `CLAUDE_CODE_OAUTH_TOKEN` overlaid on top. The override is applied at spawn time
 * ONLY — callers must never persist the returned map (it is not written to session.json
 * and not returned by /api/state). Never logs the token value.
 *
 * The token is `trim()`med before overlay so the applied value matches what
 * `isPlausibleToken` validated (it validates the trimmed form) — otherwise a
 * space-padded token would pass the guard but be written to the env with its
 * surrounding whitespace intact, failing auth with an opaque error. A token that
 * is empty/whitespace-only after trimming leaves the map unchanged (same ref).
 */
export function applyTokenOverride(
  secrets: Record<string, string>,
  token?: string | null,
): Record<string, string> {
  const t = token?.trim()
  if (!t) return secrets
  return { ...secrets, CLAUDE_CODE_OAUTH_TOKEN: t }
}

export type OverrideValidationResult = { ok: true } | { ok: false; code: ErrorCode; message: string }

/** Plausible-token shape check. Deliberately coarse and VALUE-FREE: asserts a
 *  trimmed, whitespace-free string within a sane length band without inspecting,
 *  returning, or logging the token bytes. */
function isPlausibleToken(token: string): boolean {
  const t = token.trim()
  return t.length >= 20 && t.length <= 4096 && !/\s/.test(t)
}

/**
 * Switchboard launch-time guard for the per-session model/token override (Phase 2
 * Step 6). Pairs the auth-sensitive override with a startup invariant: the override
 * is FAIL-CLOSED — rejected with a stable error code unless explicitly permitted by
 * config (an allowed-model list + a token-override master switch). The returned
 * message NEVER contains the token value (callers log the code/message, not bytes).
 *
 * Returns ok when neither override is present (the common path) — so normal session
 * launches are unaffected (byte-identical behavior).
 */
export function validateSessionOverride(
  override: { model?: string | null; token?: string | null },
  guard: { allowedModels: string[]; allowTokenOverride: boolean },
): OverrideValidationResult {
  const model = override.model
  if (model != null && model !== '') {
    if (guard.allowedModels.length === 0) {
      return {
        ok: false,
        code: 'OVERRIDE_MODEL_NOT_CONFIGURED',
        message: 'per-session model override requires switchboard.allowedModels to be configured',
      }
    }
    if (!guard.allowedModels.includes(model)) {
      return {
        ok: false,
        code: 'OVERRIDE_MODEL_NOT_ALLOWED',
        message: `model '${model}' is not in switchboard.allowedModels`,
      }
    }
  }
  const token = override.token
  if (token != null && token !== '') {
    if (!guard.allowTokenOverride) {
      return {
        ok: false,
        code: 'OVERRIDE_TOKEN_DISABLED',
        message: 'per-session token override is disabled (set switchboard.allowTokenOverride)',
      }
    }
    // typeof guard first: the token arrives from JSON.parse, so a caller could send a
    // non-string (e.g. {"token": 42}). Reject it as malformed rather than letting it
    // reach isPlausibleToken's .trim() (which throws on a number → unhandled rejection
    // in the route's async handler). Deliberately value-free message — never echo bytes.
    if (typeof token !== 'string' || !isPlausibleToken(token)) {
      return { ok: false, code: 'OVERRIDE_TOKEN_MALFORMED', message: 'per-session token override is malformed' }
    }
  }
  return { ok: true }
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
