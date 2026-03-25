import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

import type { SessionStatus } from '../../types'

// --- Types ---

/** @deprecated Use SessionStatus from src/types.ts — kept as alias for compatibility */
export type SessionState = SessionStatus
export type SessionBackend = 'docker' | 'tmux'

export interface SessionWorkspace {
  path: string | null
  worktree: boolean
  branch: string | null
  basePath: string | null
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
  /** CLI template name (from config.cliTemplates). Overrides skipPermissions/backend for command building. */
  cliTemplate: string | null
  port: number | null
  ttydPid: number | null
  created: string
  lastActive: string
}

// --- Helpers ---

function sessionDir(sessionsDir: string, name: string): string {
  return join(sessionsDir, name)
}

function sessionFile(sessionsDir: string, name: string): string {
  return join(sessionsDir, name, 'session.json')
}

export async function detectBranch(path: string): Promise<string | null> {
  if (!path) return null
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    return branch && branch !== 'HEAD' ? branch : null
  } catch {
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
  cliTemplate?: string | null
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
    cliTemplate: opts.cliTemplate ?? null,
    port: null,
    ttydPid: null,
    created: now,
    lastActive: now,
  }

  writeFileSync(sessionFile(sessionsDir, opts.name), JSON.stringify(session, null, 2))
  return session
}

export function getSession(sessionsDir: string, name: string): Session | null {
  try {
    return JSON.parse(readFileSync(sessionFile(sessionsDir, name), 'utf-8'))
  } catch {
    return null
  }
}

export function updateSession(sessionsDir: string, name: string, updates: Partial<Session>): Session | null {
  const session = getSession(sessionsDir, name)
  if (!session) return null

  const updated = { ...session, ...updates }
  // Deep merge workspace and conversation
  if (updates.workspace) {
    updated.workspace = { ...session.workspace, ...updates.workspace }
  }
  if (updates.conversation) {
    updated.conversation = { ...session.conversation, ...updates.conversation }
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
  return updateSession(sessionsDir, name, {
    state,
    lastActive: new Date().toISOString(),
  })
}

export function claudeStateDir(sessionsDir: string, sessionName: string): string {
  return join(sessionsDir, sessionName, 'claude-state')
}
