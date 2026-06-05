import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { Session, SessionNats } from '../session'
import type { TinstarConfig, CliTemplate } from '../config'
import { log } from '../../logger'

// NATS channel server paths come from config (see config.ts)
// Install: git clone https://github.com/except-pass/nats-channel-mcp && cd nats-channel-mcp && bun install

const execFileAsync = promisify(execFile)

// --- NATS control socket ---

/**
 * Path to the channel server's Unix control socket for hot subscription
 * management. Tinstar's API handlers (see sendNatsSocketCommand in routes.ts)
 * write newline-delimited JSON commands to this path to add/remove
 * subscriptions on a live session without restarting it.
 *
 * Must match the --control-socket arg passed to nats-channel-mcp in
 * generateNatsMcpConfig below. Exported so both sides use the same source.
 */
export function natsControlSocketPath(sessionName: string): string {
  return `/tmp/tinstar-nats-${sessionName}.sock`
}

// --- Naming ---

export function tmuxSessionName(config: TinstarConfig, sessionName: string): string {
  return `${config.sessions.prefix}${sessionName}`
}

export async function tmuxHasSession(tmuxName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', tmuxName])
    return true
  } catch {
    return false
  }
}

/**
 * Poll tmux pane for dev channel warning and auto-accept it.
 * More robust than fixed timeout - waits for the actual prompt to appear.
 * Polls every 500ms for up to 10 seconds.
 */
async function autoAcceptDevChannelWarning(tmuxName: string): Promise<void> {
  const maxAttempts = 20 // 10 seconds at 500ms intervals
  const interval = 500

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, interval))

    try {
      // Check if session still exists
      await execFileAsync('tmux', ['has-session', '-t', tmuxName])

      // Capture pane content
      const stdout = await captureScreen(tmuxName)

      // Look for the dev channel warning prompt
      if (stdout.includes('Enter to confirm')) {
        // Send Enter to accept
        await execFileAsync('tmux', ['send-keys', '-t', tmuxName, 'Enter'])
        log.info('tmux', `${tmuxName}: auto-accepted dev channel warning`)
        return
      }

      // Check if Claude has already started (prompt appeared without warning)
      // The "❯" prompt or "Claude Code" banner indicates we're past the warning
      if (stdout.includes('Claude Code') && !stdout.includes('WARNING:')) {
        log.info('tmux', `${tmuxName}: Claude started without dev channel warning`)
        return
      }
    } catch {
      // Session gone or capture failed, stop polling
      return
    }
  }

  log.info('tmux', `${tmuxName}: dev channel warning not detected within timeout`)
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

// Reserve a port at startup so findPort() won't hand it to a different session
// after the in-memory claimedPorts set was wiped by a server restart. Two
// sessions colliding on one port causes ttyd auto-restart wars (each session's
// startTtyd kills the other's ttyd), so the proxy /s/{name} flaps between them.
export function claimPort(port: number): void {
  claimedPorts.add(port)
}

// --- Command builders ---

/**
 * Escape a string for use in bash single quotes.
 * Single quotes don't expand anything (no $, `, !, etc.) — only ' itself needs escaping.
 * Pattern: replace ' with '\'' (end quote, escaped literal quote, start new quote)
 */
function bashSingleQuote(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

/**
 * Persistent agent definition — injected into a CLI template via the
 * {agentName} / {agentDescription} / {agentPrompt} / {agentJson} placeholders.
 * Lets a hand carry a persona that lives in the system prompt (and so
 * survives `/clear`) without baking the prompt body into the user-editable
 * template string. Different CLIs accept persona text differently, so we
 * expose multiple shapes (raw text, claude --agents JSON) and let the
 * template author pick which one to use.
 */
export interface AgentDef {
  name: string
  description: string
  prompt: string
}

/**
 * Interpolate a CLI template string. Recognized placeholders:
 *   {sessionId}        — claude session UUID
 *   {prompt}           — one-shot user message
 *   {agentName}        — persona name (e.g. "marshal")
 *   {agentDescription} — short persona description
 *   {agentPrompt}      — raw persona body (markdown), for --append-system-prompt etc.
 *   {agentJson}        — claude --agents JSON: {"<name>":{"description":...,"prompt":...}}
 *
 * Unused placeholders are stripped along with any preceding flag, so e.g.
 * `--agents {agentJson}` disappears entirely when no persona is supplied.
 */
function interpolateTemplate(
  template: string,
  vars: {
    sessionId?: string | null
    prompt?: string | null
    agent?: AgentDef | null
  },
): string {
  let cmd = template
  if (vars.sessionId) {
    cmd = cmd.replace(/\{sessionId\}/g, vars.sessionId)
  } else {
    // Remove the placeholder and any preceding flag (e.g. "--session-id {sessionId}")
    cmd = cmd.replace(/\s*\S*\s*\{sessionId\}/g, '')
  }
  if (vars.agent) {
    const agentJson = JSON.stringify({
      [vars.agent.name]: { description: vars.agent.description, prompt: vars.agent.prompt },
    })
    cmd = cmd.replace(/\{agentName\}/g, vars.agent.name)
    cmd = cmd.replace(/\{agentDescription\}/g, bashSingleQuote(vars.agent.description))
    cmd = cmd.replace(/\{agentPrompt\}/g, bashSingleQuote(vars.agent.prompt))
    cmd = cmd.replace(/\{agentJson\}/g, bashSingleQuote(agentJson))
  } else {
    // Strip placeholders + preceding flag (e.g. `--agents {agentJson}`)
    cmd = cmd.replace(/\s*\S*\s*\{agentName\}/g, '')
    cmd = cmd.replace(/\s*\S*\s*\{agentDescription\}/g, '')
    cmd = cmd.replace(/\s*\S*\s*\{agentPrompt\}/g, '')
    cmd = cmd.replace(/\s*\S*\s*\{agentJson\}/g, '')
  }
  if (vars.prompt) {
    // Use single quotes — they don't expand !, `, $, or anything else
    cmd = cmd.replace(/\{prompt\}/g, bashSingleQuote(vars.prompt))
  } else {
    // Remove "-- {prompt}" or just "{prompt}"
    cmd = cmd.replace(/\s*--\s*\{prompt\}/g, '')
    cmd = cmd.replace(/\s*\{prompt\}/g, '')
  }
  return cmd.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Write .mcp.json to the workspace CWD so Claude picks it up automatically.
 * Must use CWD placement — --mcp-config flag does NOT wire the channel server correctly.
 * Returns the path written.
 */
export function generateNatsMcpConfig(opts: {
  sessionsDir: string
  sessionName: string
  workspacePath: string
  nats: SessionNats
  channelServerPackage: string  // npm package or github:user/repo
  bunPath: string
  jetstream?: boolean
}): string {
  // Write to workspace CWD — Claude looks for .mcp.json in the working directory
  const mcpConfigPath = join(opts.workspacePath, '.mcp.json')

  // Build args: use `bun x <package>` to run from npm/github without local install
  const args: string[] = ['x', opts.channelServerPackage, '--name', opts.sessionName]
  for (const subject of opts.nats.subscriptions) {
    args.push('--subscribe', subject)
  }
  // --control-socket wires up the hot subscription management path used by
  // POST/DELETE /api/sessions/:name/subscriptions. Requires nats-channel-mcp
  // >= the commit that introduced the flag (except-pass/nats-channel-mcp#1).
  args.push('--control-socket', natsControlSocketPath(opts.sessionName))

  if (opts.jetstream) args.push('--jetstream')

  const mcpConfig = {
    mcpServers: {
      nats: {
        command: opts.bunPath,
        args,
      },
    },
  }

  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2))
  return mcpConfigPath
}

/** Build the agent CLI command from a template or legacy skipPermissions flag. */
export function buildAgentCommand(opts: {
  template?: CliTemplate | null
  skipPermissions?: boolean
  sessionId?: string | null
  resume?: boolean
  initialPrompt?: string | null
  nats?: { enabled: boolean } | null
  appendSystemPrompt?: string | null
  agent?: AgentDef | null
}): string {
  let cmd: string

  if (opts.template) {
    const tmpl = opts.resume ? opts.template.resumeCmd : opts.template.startCmd
    cmd = interpolateTemplate(tmpl, {
      sessionId: opts.sessionId,
      prompt: opts.resume ? null : opts.initialPrompt,
      agent: opts.agent,
    })
    // Only append --append-system-prompt when *this* command didn't already
    // interpolate the persona via an {agent...} placeholder. Decided per-command
    // so asymmetric templates (placeholder in only one of startCmd/resumeCmd)
    // still get the persona exactly once on both create and resume.
    const interpolatedPersona = opts.agent != null && /\{agent(Name|Description|Prompt|Json)\}/.test(tmpl)
    // Insert --append-system-prompt before the -- prompt separator if present
    if (opts.appendSystemPrompt && !interpolatedPersona) {
      const promptFlag = ` --append-system-prompt ${bashSingleQuote(opts.appendSystemPrompt)}`
      const dashDashIdx = cmd.indexOf(' -- ')
      if (dashDashIdx !== -1) {
        cmd = cmd.slice(0, dashDashIdx) + promptFlag + cmd.slice(dashDashIdx)
      } else {
        cmd += promptFlag
      }
    }
  } else {
    // Legacy fallback: build claude command from flags
    cmd = 'claude'
    if (opts.skipPermissions) cmd += ' --dangerously-skip-permissions'
    if (opts.resume && opts.sessionId) cmd += ` --resume ${opts.sessionId}`
    else if (opts.sessionId) cmd += ` --session-id ${opts.sessionId}`
    // Add NATS channel support — .mcp.json is in CWD, no --mcp-config needed
    if (opts.nats?.enabled) {
      cmd += ' --dangerously-load-development-channels server:nats'
    }
    // Add hand system prompt if specified
    if (opts.appendSystemPrompt) {
      cmd += ` --append-system-prompt ${bashSingleQuote(opts.appendSystemPrompt)}`
    }
    if (opts.initialPrompt) {
      // Use single quotes — they don't expand !, `, $, or anything else
      cmd += ` -- ${bashSingleQuote(opts.initialPrompt)}`
    }
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
    template?: CliTemplate | null
    appendSystemPrompt?: string | null
    agent?: AgentDef | null
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

  // Inject OTLP telemetry env vars when telemetry is enabled on the CLI template
  if (opts.template?.telemetry !== false) {
    const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'
    const telemetryVars: Record<string, string> = {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint,
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_RESOURCE_ATTRIBUTES: `tinstar.session=${opts.session.name}`,
    }
    for (const [key, value] of Object.entries(telemetryVars)) {
      await execFileAsync('tmux', ['set-environment', '-t', tmuxName, key, value])
    }
  }

  // Build and send agent command
  const parts = ['eval "$(tmux show-environment -s)"']

  // Generate NATS MCP config if enabled — writes .mcp.json to workspace CWD
  let natsOpts: { enabled: boolean } | null = null
  if (opts.session.nats?.enabled && opts.session.nats.subscriptions.length > 0 && opts.session.workspace?.path) {
    generateNatsMcpConfig({
      sessionsDir: config.dirs.sessions,
      sessionName: opts.session.name,
      workspacePath: opts.session.workspace.path,
      nats: opts.session.nats,
      channelServerPackage: config.nats.channelServerPackage,
      bunPath: config.nats.bunPath,
      jetstream: config.nats.jetstream,
    })
    natsOpts = { enabled: true }
    log.info('tmux', `${opts.session.name}: NATS enabled, dev channel auto-accept configured`)
  }

  const agentCmd = buildAgentCommand({
    template: opts.template,
    skipPermissions: opts.session.skipPermissions,
    sessionId: opts.session.conversation?.id,
    resume: opts.resume,
    initialPrompt: opts.resume ? undefined : opts.session.initialPrompt,
    nats: natsOpts,
    appendSystemPrompt: opts.appendSystemPrompt,
    agent: opts.agent,
  })
  parts.push(agentCmd)

  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, parts.join(' && '), 'Enter'])

  // Auto-accept dev channel warning by polling for the prompt and sending Enter
  // More robust than fixed timeout - waits for actual prompt to appear
  if (natsOpts?.enabled) {
    autoAcceptDevChannelWarning(tmuxName).catch(() => {
      // Session may have been killed or prompt not shown, ignore
    })
  }

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
    template?: CliTemplate | null
    appendSystemPrompt?: string | null
    agent?: AgentDef | null
  },
): Promise<{ port: number; ttydPid: number | undefined }> {
  const tmuxName = tmuxSessionName(config, opts.session.name)
  const exists = await tmuxHasSession(tmuxName)

  if (!exists) {
    return createTmuxSession(config, { ...opts, resume: true })
  }

  // Tmux session exists but agent may have exited — re-send the command
  const parts = ['eval "$(tmux show-environment -s)"']

  // Generate NATS MCP config if enabled — writes .mcp.json to workspace CWD
  let natsOpts: { enabled: boolean } | null = null
  if (opts.session.nats?.enabled && opts.session.nats.subscriptions.length > 0 && opts.session.workspace?.path) {
    generateNatsMcpConfig({
      sessionsDir: config.dirs.sessions,
      sessionName: opts.session.name,
      workspacePath: opts.session.workspace.path,
      nats: opts.session.nats,
      channelServerPackage: config.nats.channelServerPackage,
      bunPath: config.nats.bunPath,
      jetstream: config.nats.jetstream,
    })
    natsOpts = { enabled: true }
  }

  const agentCmd = buildAgentCommand({
    template: opts.template,
    skipPermissions: opts.session.skipPermissions,
    sessionId: opts.session.conversation?.id,
    resume: true,
    nats: natsOpts,
    appendSystemPrompt: opts.appendSystemPrompt,
    agent: opts.agent,
  })
  parts.push(agentCmd)
  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, parts.join(' && '), 'Enter'])

  // Same dev-channel auto-accept as createTmuxSession — restarting an exited
  // agent re-shows Claude's NATS warning prompt and must also be accepted.
  if (natsOpts?.enabled) {
    log.info('tmux', `${opts.session.name}: NATS enabled, dev channel auto-accept configured (restart)`)
    autoAcceptDevChannelWarning(tmuxName).catch(() => {
      // Session may have been killed or prompt not shown, ignore
    })
  }

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

export async function reattachTmuxSession(
  config: TinstarConfig,
  opts: { session: Session; port: number },
): Promise<{ port: number; ttydPid: number | undefined }> {
  const tmuxName = tmuxSessionName(config, opts.session.name)
  claimedPorts.add(opts.port)

  // If ttyd is already running on this port (e.g. another server instance owns it),
  // adopt it rather than killing and restarting — avoids a kill/restart cycle when
  // npx tinstar and npm run dev share the same config dir.
  try {
    const lsof = execSync(
      `lsof -ti :${opts.port} | xargs -r ps -o pid=,comm= -p 2>/dev/null | awk '$2=="ttyd"{print $1}'`,
      { encoding: 'utf-8' },
    ).trim()
    if (lsof) {
      return { port: opts.port, ttydPid: Number(lsof.split('\n')[0]) }
    }
  } catch { /* no ttyd running — proceed to start */ }

  const ttydPid = await startTtyd({ tmuxName, port: opts.port, sessionName: opts.session.name })
  return { port: opts.port, ttydPid }
}

/** Capture a tmux pane's rendered screen. With `scrollback`, include that many
 *  lines of history (capture-pane -S -<n>). Shared by status detection, the
 *  codex transcript, and the GET /api/sessions/:name/screen endpoint. */
export async function captureScreen(tmuxName: string, scrollback?: number): Promise<string> {
  const args = ['capture-pane', '-t', tmuxName, '-p']
  if (scrollback && scrollback > 0) args.push('-S', `-${scrollback}`)
  const { stdout } = await execFileAsync('tmux', args)
  return stdout
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

// Epoch-ms of recent auto-restarts per session, for the circuit breaker.
// Kept module-level (not on the entry) so it survives startTtyd's internal
// stopManagedTtyd → re-spawn cycle; cleared only on an explicit stop/delete.
const ttydRestartHistory = new Map<string, number[]>()

// ttyd auto-restart circuit breaker tuning. A healthy ttyd never restarts; it
// stays up for the life of the session. So even a handful of restarts in a
// short window means something is wrong (the tmux target died, or another
// process — e.g. a second backend on the same config dir — keeps killing the
// ttyd on a contended port). Without this cap, startTtyd's exit handler spins
// forever: one such war restarted ttyd 1,184 times over 23 hours.
const TTYD_RESTART_MAX = 5
const TTYD_RESTART_WINDOW_MS = 15_000

/**
 * Decide whether a ttyd that just exited should be auto-restarted.
 *
 * Pure so it can be unit-tested without spawning ttyd. Two give-up conditions:
 *  - `tmux-gone`: the tmux session ttyd attaches to no longer exists, so the
 *    session was closed/killed — restarting would attach to nothing.
 *  - `rate-limited`: too many restarts within the window, i.e. a restart-war.
 */
export function shouldRestartTtyd(opts: {
  tmuxAlive: boolean
  restartTimestamps: number[]
  now: number
  maxRestarts?: number
  windowMs?: number
}): { restart: boolean; reason: 'tmux-gone' | 'rate-limited' | 'ok' } {
  if (!opts.tmuxAlive) return { restart: false, reason: 'tmux-gone' }
  const max = opts.maxRestarts ?? TTYD_RESTART_MAX
  const windowMs = opts.windowMs ?? TTYD_RESTART_WINDOW_MS
  const recent = opts.restartTimestamps.filter((t) => opts.now - t < windowMs)
  if (recent.length >= max) return { restart: false, reason: 'rate-limited' }
  return { restart: true, reason: 'ok' }
}

export interface TtydIncumbent {
  pid: number
  /** tmux session this ttyd attaches (e.g. "tinstar-foo"), or null if unknown. */
  tmuxTarget: string | null
}

/** ttyd processes listening on `port`, each with the tmux session it attaches. */
export function ttydIncumbentsOnPort(port: number): TtydIncumbent[] {
  const out: TtydIncumbent[] = []
  let pidLines: string
  try {
    pidLines = execSync(
      `lsof -ti :${port} | xargs -r ps -o pid=,comm= -p 2>/dev/null | awk '$2=="ttyd"{print $1}'`,
      { encoding: 'utf-8' },
    ).trim()
  } catch {
    return out // nothing on the port
  }
  if (!pidLines) return out
  for (const line of pidLines.split('\n')) {
    const pid = Number(line)
    if (!pid) continue
    let tmuxTarget: string | null = null
    try {
      const args = execSync(`ps -o args= -p ${pid}`, { encoding: 'utf-8' })
      const m = args.match(/tmux attach -t (\S+)/)
      tmuxTarget = m ? m[1]! : null
    } catch { /* process vanished between lsof and ps */ }
    out.push({ pid, tmuxTarget })
  }
  return out
}

/**
 * Partition ttyd incumbents on a contended port: which we may kill to reclaim
 * the port (our own previous ttyd, or one we can't identify) vs. foreign ones
 * serving a different live session (which we must NOT kill — that's the
 * kill-war). Pure, for testing.
 */
export function ttydPidsToReclaim(
  incumbents: TtydIncumbent[],
  ourTmuxName: string,
): { kill: number[]; foreign: TtydIncumbent[] } {
  const kill: number[] = []
  const foreign: TtydIncumbent[] = []
  for (const inc of incumbents) {
    if (inc.tmuxTarget === null || inc.tmuxTarget === ourTmuxName) kill.push(inc.pid)
    else foreign.push(inc)
  }
  return { kill, foreign }
}

export function startTtyd(opts: {
  tmuxName: string
  port: number
  sessionName: string
}): Promise<number | undefined> {
  // resetHistory:false — preserve the restart-rate history across an
  // auto-restart so the circuit breaker can count cumulative restarts.
  stopManagedTtyd(opts.sessionName, { resetHistory: false })

  // Reclaim the port from an orphaned ttyd (e.g. after a server restart), but
  // ONLY from our own previous ttyd or one we can't identify. Killing a ttyd
  // that serves a *different* live session is the kill-war: each session's
  // startTtyd kills the other's ttyd, both auto-restart, and the proxy /s/{name}
  // flaps between the two terminals. If a foreign session holds the port we
  // leave it alone and let the bind fail — the circuit breaker then backs off
  // instead of warring.
  const { kill, foreign } = ttydPidsToReclaim(ttydIncumbentsOnPort(opts.port), opts.tmuxName)
  for (const pid of kill) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
  }
  if (foreign.length > 0) {
    log.warn('ttyd', `${opts.sessionName}: port ${opts.port} held by another session (${foreign.map(f => f.tmuxTarget).join(', ')}); not killing it`)
  }

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

    // Auto-restart on unexpected exit — but only when it's actually warranted.
    // Bare unconditional restart spins forever when the tmux target is gone
    // (closed session) or when something keeps killing ttyd on a contended
    // port (a second backend on the same config dir). See shouldRestartTtyd.
    child.on('exit', (code) => {
      const entry = managedTtyd.get(opts.sessionName)
      if (!entry || entry.stopped) {
        managedTtyd.delete(opts.sessionName)
        return
      }
      void tmuxHasSession(opts.tmuxName).then((tmuxAlive) => {
        const cur = managedTtyd.get(opts.sessionName)
        if (!cur || cur.stopped) {
          managedTtyd.delete(opts.sessionName)
          return
        }
        const now = Date.now()
        const history = (ttydRestartHistory.get(opts.sessionName) ?? []).filter(
          (t) => now - t < TTYD_RESTART_WINDOW_MS,
        )
        const decision = shouldRestartTtyd({ tmuxAlive, restartTimestamps: history, now })
        if (!decision.restart) {
          log.info('ttyd', `${opts.sessionName}: exited (code ${code}), not restarting (${decision.reason})`)
          managedTtyd.delete(opts.sessionName)
          ttydRestartHistory.delete(opts.sessionName)
          return
        }
        log.info('ttyd', `${opts.sessionName}: exited (code ${code}), restarting in 2s...`)
        cur.restartTimer = setTimeout(() => {
          ttydRestartHistory.set(opts.sessionName, [...history, Date.now()])
          startTtyd(opts).then(pid => {
            log.info('ttyd', `${opts.sessionName}: restarted`, { pid })
            if (cur.onRestart && pid) cur.onRestart(pid)
          }).catch(err => {
            log.error('ttyd', `${opts.sessionName}: restart failed`, { error: (err as Error).message })
          })
        }, 2000)
      })
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

export function stopManagedTtyd(sessionName: string, opts: { resetHistory?: boolean } = {}): void {
  const entry = managedTtyd.get(sessionName)
  if (entry) {
    entry.stopped = true
    if (entry.restartTimer) clearTimeout(entry.restartTimer)
    try { entry.child.kill('SIGTERM') } catch { /* already dead */ }
    managedTtyd.delete(sessionName)
  }
  // An explicit stop is a clean slate: a later manual (re)start should not be
  // rate-limited by restarts from before the stop. The internal teardown at
  // the top of startTtyd passes resetHistory:false so the circuit breaker
  // still sees the cumulative restart rate across an auto-restart cycle.
  if (opts.resetHistory !== false) ttydRestartHistory.delete(sessionName)
}

export function onTtydRestart(sessionName: string, callback: (pid: number) => void): void {
  const entry = managedTtyd.get(sessionName)
  if (entry) entry.onRestart = callback
}

/**
 * Force the target pane fully out of copy-mode and any active command-prompt
 * overlay (the yellow bar — search-forward, jump-backward, goto-line, etc.).
 *
 * Two failure modes that the naive "-X cancel" doesn't handle:
 *   1. Command-prompt overlays in vi copy-mode (`:` `/` `?` `f` `F` `t` `T`)
 *      are server-side overlays, not pane modes. -X cancel doesn't dismiss
 *      them — they need a literal Escape keystroke. While the overlay is
 *      active, copy-mode itself remains active and any subsequent text goes
 *      to the mode handler, where the *next* prompt char (e.g. ':') opens
 *      *another* overlay (e.g. "(goto line)").
 *   2. Session-level targets (`-t sessionName`) resolve to "active pane in
 *      active window" each time, which can shift between commands. We
 *      resolve a stable pane_id once and use it everywhere.
 */
async function exitAnyMode(tmuxName: string): Promise<void> {
  let paneId: string
  try {
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', tmuxName, '#{pane_id}'])
    paneId = stdout.trim()
    if (!paneId) return
  } catch {
    return
  }

  for (let i = 0; i < 5; i++) {
    let inMode = '0'
    try {
      const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])
      inMode = stdout.trim()
    } catch {
      return
    }
    if (inMode !== '1') return

    // Literal Escape: dismisses any active command-prompt overlay. In
    // copy-mode (which we've confirmed via pane_in_mode) Escape is bound to
    // cancel/clear-selection — it never reaches the underlying shell.
    try {
      await execFileAsync('tmux', ['send-keys', '-t', paneId, 'Escape'])
    } catch {
      // ignore — re-check on next iter
    }
    // -X cancel: exits copy-mode itself once any overlay is dismissed.
    try {
      await execFileAsync('tmux', ['send-keys', '-X', 'cancel', '-t', paneId])
    } catch {
      // "not currently in a mode" — already exited; loop will confirm
    }
  }
}

export async function sendKeys(config: TinstarConfig, sessionName: string, keys: string[]): Promise<void> {
  const tmuxName = tmuxSessionName(config, sessionName)
  await exitAnyMode(tmuxName)
  await execFileAsync('tmux', ['send-keys', '-t', tmuxName, ...keys])
}

export async function sendPrompt(config: TinstarConfig, sessionName: string, prompt: string): Promise<void> {
  const tmuxName = tmuxSessionName(config, sessionName)
  // The pane enters copy-mode when the user scrolls in the ttyd terminal.
  // While in copy-mode (or a nested sub-prompt like search/jump), send-keys
  // text goes to the mode handler instead of the underlying process — which
  // is how a prompt starting with 'F' silently triggers "jump backward".
  await exitAnyMode(tmuxName)
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

