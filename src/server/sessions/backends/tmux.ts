import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '../session'
import type { TinstarConfig } from '../config'

const execFileAsync = promisify(execFile)

// --- Naming ---

export function tmuxSessionName(config: TinstarConfig, sessionName: string): string {
  return `${config.container.prefix}${sessionName}`
}

export async function tmuxHasSession(tmuxName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', tmuxName])
    return true
  } catch {
    return false
  }
}

// --- Port management ---

const claimedPorts = new Set<number>()

async function tryPort(port: number): Promise<boolean> {
  if (claimedPorts.has(port)) return false
  const net = await import('node:net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
    server.on('error', () => resolve(false))
  })
}

export async function findPort(start: number = 8681): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (await tryPort(port)) {
      claimedPorts.add(port)
      return port
    }
  }
  throw new Error(`No available port found in range ${start}-${start + 99}`)
}

export function releasePort(port: number): void {
  claimedPorts.delete(port)
}

// --- Command builders ---

export function buildClaudeCommand(opts: {
  skipPermissions?: boolean
  sessionId?: string | null
  resume?: boolean
  initialPrompt?: string | null
} = {}): string {
  let cmd = 'claude'
  if (opts.skipPermissions) {
    cmd += ' --dangerously-skip-permissions'
  }
  if (opts.resume && opts.sessionId) {
    cmd += ` --resume ${opts.sessionId}`
  } else if (opts.sessionId) {
    cmd += ` --session-id ${opts.sessionId}`
  }
  if (opts.initialPrompt) {
    cmd += ` -- ${JSON.stringify(opts.initialPrompt)}`
  }
  return cmd
}

// --- Tmux operations ---

export async function createTmuxSession(
  config: TinstarConfig,
  opts: {
    session: Session & { initialPrompt?: string }
    secrets: Record<string, string>
    port: number
    resume?: boolean
  },
): Promise<{ port: number; ttydPid: number | undefined }> {
  const tmuxName = tmuxSessionName(config, opts.session.name)

  const tmuxArgs = ['-f', '/dev/null', 'new', '-d', '-s', tmuxName]
  if (opts.session.workspace?.path) {
    tmuxArgs.push('-c', opts.session.workspace.path)
  }
  await execFileAsync('tmux', tmuxArgs)

  // Configure tmux
  await execFileAsync('tmux', ['set', '-t', tmuxName, 'status', 'off'])
  await execFileAsync('tmux', ['set', '-t', tmuxName, 'mouse', 'on'])
  // Ctrl+Backspace: xterm.js sends 0x08 (C-h) — remap to word-erase (C-w)
  await execFileAsync('tmux', ['bind-key', '-n', 'C-h', 'send-keys', 'C-w'])

  // Inject session identity + secrets into tmux environment
  await execFileAsync('tmux', ['set-environment', '-t', tmuxName, 'TINSTAR_SESSION_NAME', opts.session.name])
  for (const [key, value] of Object.entries(opts.secrets)) {
    if (value) {
      await execFileAsync('tmux', ['set-environment', '-t', tmuxName, key, value])
    }
  }

  // Build and send claude command
  const claudeParts = ['eval "$(tmux show-environment -s)"']
  const claudeCmd = buildClaudeCommand({
    skipPermissions: opts.session.skipPermissions,
    sessionId: opts.session.conversation?.id,
    resume: opts.resume,
    initialPrompt: opts.resume ? undefined : opts.session.initialPrompt,
  })
  claudeParts.push(claudeCmd)

  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, claudeParts.join(' && '), 'Enter'])

  // Start ttyd
  const ttydPid = await startTtyd({ tmuxName, port: opts.port, sessionName: opts.session.name })

  return { port: opts.port, ttydPid }
}

export async function startTmuxSession(
  config: TinstarConfig,
  opts: {
    session: Session & { initialPrompt?: string }
    secrets: Record<string, string>
    port: number
  },
): Promise<{ port: number; ttydPid: number | undefined }> {
  const tmuxName = tmuxSessionName(config, opts.session.name)
  const exists = await tmuxHasSession(tmuxName)

  if (!exists) {
    return createTmuxSession(config, { ...opts, resume: true })
  }

  // Tmux session exists but Claude may have exited — re-send the claude command
  const claudeParts = ['eval "$(tmux show-environment -s)"']
  const claudeCmd = buildClaudeCommand({
    skipPermissions: opts.session.skipPermissions,
    sessionId: opts.session.conversation?.id,
    resume: true,
  })
  claudeParts.push(claudeCmd)
  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, claudeParts.join(' && '), 'Enter'])

  // Restart ttyd
  const ttydPid = await startTtyd({ tmuxName, port: opts.port, sessionName: opts.session.name })
  return { port: opts.port, ttydPid }
}

export async function stopTmuxSession(config: TinstarConfig, session: Session): Promise<void> {
  stopManagedTtyd(session.name)

  const tmuxName = tmuxSessionName(config, session.name)
  try {
    await execFileAsync('tmux', ['kill-session', '-t', tmuxName])
  } catch {
    // Already gone
  }
}

export async function deleteTmuxSession(config: TinstarConfig, session: Session): Promise<void> {
  stopManagedTtyd(session.name)

  const tmuxName = tmuxSessionName(config, session.name)
  try {
    await execFileAsync('tmux', ['kill-session', '-t', tmuxName])
  } catch {
    // Already gone
  }
}

export async function getTmuxSessionState(config: TinstarConfig, sessionName: string): Promise<'exists' | 'missing'> {
  const tmuxName = tmuxSessionName(config, sessionName)
  const exists = await tmuxHasSession(tmuxName)
  return exists ? 'exists' : 'missing'
}

// --- ttyd management ---

interface ManagedTtydEntry {
  child: ChildProcess
  tmuxName: string
  port: number
  stopped: boolean
  restartTimer?: ReturnType<typeof setTimeout>
  onRestart?: (pid: number) => void
}

const managedTtyd = new Map<string, ManagedTtydEntry>()

export function startTtyd(opts: {
  tmuxName: string
  port: number
  sessionName: string
}): Promise<number | undefined> {
  stopManagedTtyd(opts.sessionName)

  // Kill any orphaned ttyd still holding the port (e.g. after server restart)
  try {
    const lsof = execSync(`lsof -ti :${opts.port}`, { encoding: 'utf-8' }).trim()
    if (lsof) {
      for (const pid of lsof.split('\n')) {
        try { process.kill(Number(pid), 'SIGTERM') } catch { /* already dead */ }
      }
    }
  } catch { /* no process on port — good */ }

  return new Promise((resolve, reject) => {
    const child = spawn('ttyd', [
      '-W',
      '-p', String(opts.port),
      '-t', 'titleFixed=Tinstar',
      '-t', 'theme={"background":"#000000"}',
      'bash', '-c', `tmux attach -t ${opts.tmuxName}`,
    ], {
      stdio: 'ignore',
    })

    child.on('error', reject)

    // Auto-restart on unexpected exit
    child.on('exit', (code) => {
      const entry = managedTtyd.get(opts.sessionName)
      if (!entry || entry.stopped) {
        managedTtyd.delete(opts.sessionName)
        return
      }
      console.log(`[ttyd] ${opts.sessionName}: exited (code ${code}), restarting in 2s...`)
      entry.restartTimer = setTimeout(() => {
        startTtyd(opts).then(pid => {
          console.log(`[ttyd] ${opts.sessionName}: restarted (pid ${pid})`)
          if (entry.onRestart && pid) entry.onRestart(pid)
        }).catch(err => {
          console.error(`[ttyd] ${opts.sessionName}: restart failed:`, (err as Error).message)
        })
      }, 2000)
    })

    managedTtyd.set(opts.sessionName, {
      child,
      tmuxName: opts.tmuxName,
      port: opts.port,
      stopped: false,
    })

    // Give ttyd a moment to bind the port
    setTimeout(() => resolve(child.pid), 500)
  })
}

export function stopManagedTtyd(sessionName: string): void {
  const entry = managedTtyd.get(sessionName)
  if (!entry) return
  entry.stopped = true
  if (entry.restartTimer) clearTimeout(entry.restartTimer)
  try { entry.child.kill('SIGTERM') } catch { /* already dead */ }
  managedTtyd.delete(sessionName)
}

export function onTtydRestart(sessionName: string, callback: (pid: number) => void): void {
  const entry = managedTtyd.get(sessionName)
  if (entry) entry.onRestart = callback
}

export async function sendKeys(config: TinstarConfig, sessionName: string, keys: string[]): Promise<void> {
  const tmuxName = tmuxSessionName(config, sessionName)
  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, ...keys])
}

export async function sendPrompt(config: TinstarConfig, sessionName: string, prompt: string): Promise<void> {
  const tmuxName = tmuxSessionName(config, sessionName)
  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, prompt, ''])
  await new Promise(r => setTimeout(r, 300))
  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, '', 'Enter'])
}

export async function healthCheck(port: number, opts: { timeout?: number; interval?: number } = {}): Promise<boolean> {
  const { timeout = 5000, interval = 500 } = opts
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/`)
      if (response.ok) return true
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, interval))
  }
  return false
}

// --- Hooks management ---

export async function installHooks(
  workspacePath: string,
  _sessionName: string,
  dashboardUrl: string,
): Promise<void> {
  const claudeDir = join(workspacePath, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')

  mkdirSync(claudeDir, { recursive: true })

  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* empty */ }

  const hooks = (existing.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>

  // Use $TINSTAR_SESSION_NAME env var so the hook only fires for sessions that have it set.
  // Non-managed Claude instances (e.g. the user's own session) won't have it, so the curl
  // sends an empty name and the server rejects it — no false state updates.
  const hookCmd = (endpoint: string) =>
    `if [ -n "$TINSTAR_SESSION_NAME" ]; then curl -s -X POST ${dashboardUrl}/api/hooks/${endpoint} -H 'Content-Type: application/json' -d "{\\"session\\":\\"$TINSTAR_SESSION_NAME\\",\\"conversationId\\":\\"$CLAUDE_SESSION_ID\\"}"; fi`

  // PostToolUse hooks for file tracking — reads tool input JSON from stdin (Claude Code pipes it)
  const fileHookCmd = (endpoint: string) =>
    `if [ -n "$TINSTAR_SESSION_NAME" ]; then ` +
    `HOOK_INPUT=$(cat); ` +
    `FILE_PATH=$(echo "$HOOK_INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'); ` +
    `if [ -n "$FILE_PATH" ]; then ` +
    `curl -s -X POST ${dashboardUrl}/api/hooks/${endpoint} -H 'Content-Type: application/json' -d "{\\"session\\":\\"$TINSTAR_SESSION_NAME\\",\\"path\\":\\"$FILE_PATH\\"}"; ` +
    `fi; fi`

  const tinstarHooks: Record<string, Array<Record<string, unknown>>> = {
    Stop: [{
      hooks: [{ type: 'command', command: hookCmd('idle') }],
    }],
    PreToolUse: [{
      matcher: '',
      hooks: [{ type: 'command', command: hookCmd('active') }],
    }],
    UserPromptSubmit: [{
      hooks: [{ type: 'command', command: hookCmd('active') }],
    }],
    PostToolUse: [
      {
        matcher: 'Write|Edit',
        hooks: [{ type: 'command', command: fileHookCmd('file-touched') }],
      },
      {
        matcher: 'Read',
        hooks: [{ type: 'command', command: fileHookCmd('file-read') }],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: hookCmd('file-touched') }],
      },
    ],
  }

  for (const [event, entries] of Object.entries(tinstarHooks)) {
    hooks[event] = hooks[event] ?? []
    // Remove previous tinstar hooks (identified by /api/hooks/ in command)
    hooks[event] = hooks[event].filter(
      (h: Record<string, unknown>) => !(h.hooks as Array<Record<string, unknown>>)?.some(
        (hh: Record<string, unknown>) => (hh.command as string)?.includes('/api/hooks/')
      )
    )
    hooks[event].push(...entries)
  }

  existing.hooks = hooks
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

export async function removeHooks(workspacePath: string): Promise<void> {
  const settingsPath = join(workspacePath, '.claude', 'settings.json')
  let settings: Record<string, unknown>
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return }

  const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>> | undefined
  if (!hooks) return

  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? []).filter(
      (h: Record<string, unknown>) => !(h.hooks as Array<Record<string, unknown>>)?.some(
        (hh: Record<string, unknown>) => (hh.command as string)?.includes('/api/hooks/')
      )
    )
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}
