import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

import type { SessionStatus } from '../../types'
import { flushOnStateChange } from '../observability/turn-length'

// --- Types ---

/** @deprecated Use SessionStatus from src/types.ts — kept as alias for compatibility */
export type SessionState = SessionStatus
export type SessionBackend = 'tmux'

export interface SessionWorkspace {
  path: string | null
  worktree: boolean
  branch: string | null
  basePath: string | null
}

export interface SessionNats {
  enabled: boolean
  subscriptions: string[]
}

export interface Session {
  name: string
  backend: SessionBackend
  state: SessionState
  project: string | null
  workspace: SessionWorkspace
  conversation: { id: string | null }
  profile: string | null
  oneshot: boolean
  skipPermissions: boolean
  /**
   * Background session: fully alive and commandable (NATS + prompt endpoint)
   * but hidden from the canvas, hierarchy sidebar, inbox, and session cycling
   * by default. Server-persisted truth — consumers filter on the Run
   * projection's mirror of this flag.
   */
  background: boolean
  /**
   * Agent is stuck on a pending tool_use (permission prompt) with no child
   * processes running. Persisted so attention can be re-derived from
   * `(status, blocked, background)` across restarts and flag flips instead of
   * relying on the StatusWatcher's in-memory override state.
   */
  blocked: boolean
  /** CLI template name (from config.cliTemplates). Overrides skipPermissions/backend for command building. */
  cliTemplate: string | null
  /** Transcript adapter type — determines how to find and parse agent logs */
  adapter: string | null
  /** NATS channel configuration — enables agent-to-agent messaging */
  nats: SessionNats | null
  port: number | null
  ttydPid: number | null
  /**
   * ISO timestamp when the session's NATS control socket was detected as
   * orphaned (file present on disk but listener gone — typically from an
   * MCP-server restart collision in except-pass/nats-channel-mcp). Once
   * orphaned, dynamic subscribes will never take effect until the session
   * is restarted. `null` means healthy or unverified. Cleared on session
   * restart by state transitions in routes.ts.
   */
  natsControlOrphanedAt: string | null
  /**
   * Extra text appended to the agent's system prompt via the CLI's
   * --append-system-prompt. Persisted so a later `/start` (which recreates the
   * tmux process) re-injects a hand's resolved prompt instead of dropping it.
   * `null` for plain template sessions.
   */
  appendSystemPrompt: string | null
  /**
   * Persistent persona substituted into the CLI template via the
   * {agentName}/{agentDescription}/{agentPrompt}/{agentJson} placeholders.
   * Persisted so a later `/start` (which recreates the tmux process) can
   * re-interpolate the persona for templates that carry persona placeholders
   * (e.g. the marshal's `--append-system-prompt {agentPrompt}`). `null` for
   * sessions without a persona.
   */
  agent: { name: string; description: string; prompt: string } | null
  /**
   * Per-session model override (Switchboard). When non-null, the agent launches
   * with `--model <modelOverride>` appended to the resolved command, overriding
   * the CLI template's baked model. Persisted so a later `/start` (which recreates
   * the tmux process) re-applies it. `null` = use the template/global default —
   * byte-identical to pre-override behavior. NOTE: the companion per-session *token*
   * override is deliberately NOT persisted here (it is applied as a spawn-time-only
   * secret overlay in routes.ts and never written to disk or returned by /api/state).
   */
  modelOverride: string | null
  created: string
  lastActive: string
  /**
   * Model the session's latest assistant turn ran on (e.g. `claude-opus-4-8`),
   * derived from the transcript's per-turn `message.model`. NOT persisted to
   * `session.json` — it is enriched onto the snapshot the `/api/state` route
   * returns (see routes.ts). `null` for a session with no assistant turn yet
   * (pre-first-response) or no discoverable transcript.
   */
  model?: string | null
}

// --- Helpers ---

function sessionDir(sessionsDir: string, name: string): string {
  return join(sessionsDir, name)
}

function sessionFile(sessionsDir: string, name: string): string {
  return join(sessionsDir, name, 'session.json')
}

// Branch cache keyed by workdir. The branch only changes when .git/HEAD
// changes, so stat'ing one file lets us skip the git subprocess on the 3s
// status-watcher tick when nothing has moved. Memory grows with unique
// workdirs the server has ever seen; bounded by the session count.
//
// Invalidation guarantees: `.git/HEAD`'s mtime advances on every `git
// checkout`, `git switch`, and most ref updates. `git reset` and operations
// that only mutate packed-refs may not advance HEAD's mtime — those are
// rare in normal session workflows. If a caller observes stale branch info,
// touch HEAD or call _resetBranchCacheForTests in test setup.
const branchCache = new Map<string, { headMtime: number; branch: string | null }>()

export function _resetBranchCacheForTests(): void {
  branchCache.clear()
}

export async function detectBranch(path: string): Promise<string | null> {
  if (!path) return null
  let headMtime: number | null = null
  try {
    headMtime = statSync(join(path, '.git/HEAD')).mtimeMs
  } catch {
    // No .git/HEAD — not a git repo, or detached worktree pointing elsewhere.
    // Fall through and let git rev-parse handle it; just don't cache.
  }

  if (headMtime !== null) {
    const cached = branchCache.get(path)
    if (cached && cached.headMtime === headMtime) return cached.branch
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    const result = branch && branch !== 'HEAD' ? branch : null
    if (headMtime !== null) branchCache.set(path, { headMtime, branch: result })
    return result
  } catch {
    if (headMtime !== null) branchCache.set(path, { headMtime, branch: null })
    return null
  }
}

// --- Public API ---

export interface CreateSessionOpts {
  name: string
  backend: SessionBackend
  project?: string | null
  workspace?: Partial<SessionWorkspace>
  profile?: string | null
  oneshot?: boolean
  skipPermissions?: boolean
  background?: boolean
  blocked?: boolean
  cliTemplate?: string | null
  adapter?: string | null
  nats?: SessionNats | null
  appendSystemPrompt?: string | null
  agent?: { name: string; description: string; prompt: string } | null
  modelOverride?: string | null
}

export function createSession(sessionsDir: string, opts: CreateSessionOpts): Session {
  const dir = sessionDir(sessionsDir, opts.name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'claude-state'), { recursive: true })

  const now = new Date().toISOString()
  const session: Session = {
    name: opts.name,
    backend: opts.backend,
    state: 'creating',
    project: opts.project ?? null,
    workspace: {
      path: opts.workspace?.path ?? null,
      worktree: opts.workspace?.worktree ?? false,
      branch: opts.workspace?.branch ?? null,
      basePath: opts.workspace?.basePath ?? null,
    },
    conversation: { id: randomUUID() },
    profile: opts.profile ?? null,
    oneshot: opts.oneshot ?? false,
    skipPermissions: opts.skipPermissions ?? false,
    background: opts.background ?? false,
    blocked: opts.blocked ?? false,
    cliTemplate: opts.cliTemplate ?? null,
    adapter: opts.adapter ?? null,
    nats: opts.nats ?? null,
    port: null,
    ttydPid: null,
    natsControlOrphanedAt: null,
    appendSystemPrompt: opts.appendSystemPrompt ?? null,
    agent: opts.agent ?? null,
    modelOverride: opts.modelOverride ?? null,
    created: now,
    lastActive: now,
  }

  writeFileSync(sessionFile(sessionsDir, opts.name), JSON.stringify(session, null, 2))
  return session
}

export function getSession(sessionsDir: string, name: string): Session | null {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(sessionsDir, name), 'utf-8')) as Session
    // Backfill fields added after sessions were persisted so callers can
    // assume the type as declared.
    if (raw.natsControlOrphanedAt === undefined) raw.natsControlOrphanedAt = null
    if (raw.appendSystemPrompt === undefined) raw.appendSystemPrompt = null
    if (raw.agent === undefined) raw.agent = null
    if (raw.modelOverride === undefined) raw.modelOverride = null
    if (raw.background === undefined) raw.background = false
    if (raw.blocked === undefined) raw.blocked = false
    return raw
  } catch {
    return null
  }
}

export function updateSession(sessionsDir: string, name: string, updates: Partial<Session>): Session | null {
  const session = getSession(sessionsDir, name)
  if (!session) return null

  const updated = { ...session, ...updates }
  // Deep merge workspace, conversation, and nats
  if (updates.workspace) {
    updated.workspace = { ...session.workspace, ...updates.workspace }
  }
  if (updates.conversation) {
    updated.conversation = { ...session.conversation, ...updates.conversation }
  }
  if (updates.nats && session.nats) {
    updated.nats = { ...session.nats, ...updates.nats }
  }

  writeFileSync(sessionFile(sessionsDir, name), JSON.stringify(updated, null, 2))
  return updated
}

export function deleteSession(sessionsDir: string, name: string): boolean {
  const dir = sessionDir(sessionsDir, name)
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export async function listSessions(sessionsDir: string): Promise<Session[]> {
  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true, encoding: 'utf8' as const })
  } catch {
    return []
  }

  const sessions: Session[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(sessionsDir, entry.name, '.deleting'))) continue
    const session = getSession(sessionsDir, entry.name)
    if (session) {
      if (session.workspace?.path) {
        if (!existsSync(session.workspace.path)) {
          session.workspace.path = null
          session.workspace.branch = null
        } else {
          session.workspace.branch = await detectBranch(session.workspace.path)
        }
      }
      sessions.push(session)
    }
  }
  return sessions
}

export function setConversationId(sessionsDir: string, name: string, conversationId: string): Session | null {
  return updateSession(sessionsDir, name, {
    conversation: { id: conversationId },
  } as Partial<Session>)
}

export function setState(sessionsDir: string, name: string, state: SessionState): Session | null {
  const updates: Partial<Session> = {
    state,
    lastActive: new Date().toISOString(),
  }
  // A stopped session cannot be waiting on a permission prompt — clear the
  // persisted blocked flag so it can't dangle across a restart (every path
  // that stops a session — watcher, reconcile, /stop route — funnels here).
  if (state === 'stopped') updates.blocked = false
  const result = updateSession(sessionsDir, name, updates)
  if (result && state === 'stopped') {
    flushOnStateChange(name, state)
  }
  return result
}

export function claudeStateDir(sessionsDir: string, sessionName: string): string {
  return join(sessionsDir, sessionName, 'claude-state')
}
