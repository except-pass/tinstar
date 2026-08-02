import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import type { Session, SessionNats } from '../session'
import { portWindowsOverlap, type TinstarConfig, type CliTemplate, type PortWindow } from '../config'
import { isCursorAgentTemplate, ensureCursorWorkspaceTrust } from '../cursor-trust'
import { serializeByKey } from './serializeByKey'
import {
  describeTtydFailure,
  type NonCausalInterruptionError,
  TTYD_NON_CAUSAL_INTERRUPTION,
} from './ttyd-diagnostics'
import { guestEnv, tmuxEnvRemovals, parseTmuxEnvNames, describeGuestEnvScoping } from '../guestEnv'
import { log } from '../../logger'
import {
  defaultProviderRegistry,
  providerTelemetryEnabled,
  requireProviderCapability,
  type TerminalProviderAdapter,
} from '../../providers/lifecycle'
import { natsBrokerUrl } from '../../nats/url'
import {
  messageRouterSubject,
  TINSTAR_AGENT_INCARNATION_ENV,
  TINSTAR_MESSAGE_ROUTER_AUTH_ENV,
  TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV,
  TINSTAR_NATS_URL_ENV,
} from '../../messaging/message-router-address'
import {
  deriveMessageRouterSessionKey,
  messageRouterMasterKey,
} from '../../messaging/message-router-auth'
import { natsControlSocketPath } from '../nats-control'
export { natsControlSocketPath } from '../nats-control'

// NATS channel server paths come from config (see config.ts)
// Install: git clone https://github.com/except-pass/nats-channel-mcp && cd nats-channel-mcp && bun install

const rawExecFileAsync = promisify(execFile)

// Every tmux command runs through this. Session-write API endpoints (create, /prompt,
// stop, …) `await` these, and a tmux server can wedge (a stuck client, a hung pane,
// an unresponsive socket). WITHOUT a timeout a wedged `tmux` makes the awaiting HTTP
// handler hang forever with no response (curl exit 28) — and a try/catch can't save a
// hang, only a rejection. The timeout kills the child and REJECTS, which the routes'
// existing try/catch turns into a clean 5xx instead of an infinite hang. GET endpoints
// that run no tmux commands stay responsive throughout, which is exactly the reported
// symptom. 10s is far above any healthy tmux command (<1s) so it never trips normally.
const TMUX_EXEC_TIMEOUT_MS = 10_000
const strictProbeWarnings = new Set<string>()
function execFileAsync(
  file: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  // No encoding option ⇒ stdout/stderr are utf8 strings (matches the prior behavior).
  return rawExecFileAsync(file, args as string[], { timeout: TMUX_EXEC_TIMEOUT_MS, ...opts }) as Promise<{ stdout: string; stderr: string }>
}

// --- OS clipboard integration ---

// Candidate "stdin -> system clipboard" commands, in priority order. WSL
// exposes the Windows clipboard via clip.exe; macOS and Linux use their
// native tools. The first one present on PATH wins.
// MUST stay hardcoded literals: getClipboardCommand() string-interpolates the
// binary name into `command -v ${bin}` via execSync. With these constants that's
// injection-safe (no external input reaches the shell); if this list ever becomes
// config/env-derived, switch the probe to execFileSync('command', ['-v', bin]).
const CLIPBOARD_CANDIDATES = [
  'clip.exe', // WSL -> Windows clipboard
  'pbcopy', // macOS
  'wl-copy', // Linux (Wayland)
  'xclip -selection clipboard -in', // Linux (X11)
  'xsel --clipboard --input', // Linux (X11, alternate)
] as const

/**
 * Pick the first clipboard command whose binary is available, per `exists`.
 * Pure (the host probe is injected) so it can be unit-tested without spawning.
 */
export function resolveClipboardCommand(exists: (bin: string) => boolean): string | null {
  for (const cmd of CLIPBOARD_CANDIDATES) {
    if (exists(cmd.split(' ', 1)[0]!)) return cmd
  }
  return null
}

// Memoized: the available clipboard tool doesn't change at runtime.
let memoizedClipboardCmd: string | null | undefined
function getClipboardCommand(): string | null {
  if (memoizedClipboardCmd === undefined) {
    memoizedClipboardCmd = resolveClipboardCommand((bin) => {
      try {
        execSync(`command -v ${bin}`, { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })
  }
  return memoizedClipboardCmd
}

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
/**
 * Path to the session's NATS topics file (one subject per line). The per-session
 * nats-mcp.json passes this to the channel server via --topics-file, keeping the
 * variable-length subscription list out of the config file itself. Lives in the
 * per-session config dir, not the git workspace.
 */
export function natsTopicsFilePath(sessionsDir: string, sessionName: string): string {
  return join(sessionsDir, sessionName, 'nats-topics.txt')
}

// --- Naming ---

export function tmuxSessionName(config: TinstarConfig, sessionName: string): string {
  return `${config.sessions.prefix}${sessionName}`
}

/**
 * Force tmux to resolve a session target by exact name.
 *
 * Bare targets are prefix-matched when the named session is gone, so targeting
 * `tinstar-parent` can otherwise resolve to a live spawned session named
 * `tinstar-parent-reviewer-ab12`. Keep canonical names raw everywhere else and
 * add tmux's `=` marker only at command boundaries.
 */
export function exactTmuxSessionTarget(tmuxName: string): string {
  return `=${tmuxName}`
}

/**
 * Force commands that accept a pane or window target to resolve the session
 * portion exactly. The trailing colon selects that session's active window
 * instead of treating `=name` as a literal pane identifier.
 */
export function exactTmuxPaneTarget(tmuxName: string): string {
  return `${exactTmuxSessionTarget(tmuxName)}:`
}

export async function tmuxHasSession(tmuxName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', exactTmuxSessionTarget(tmuxName)])
    return true
  } catch {
    return false
  }
}

/** Return true only for tmux's known, ordinary "session is absent" failures. */
export function isOrdinaryTmuxSessionMiss(
  error: unknown,
  stderr: string | Buffer | undefined,
): boolean {
  const failure = error as {
    code?: string | number
    killed?: boolean
    signal?: NodeJS.Signals | string | null
  }
  if (
    (failure.code !== 1 && failure.code !== '1')
    || failure.killed === true
    || failure.signal != null
  ) {
    return false
  }

  const message = (
    typeof stderr === 'string' ? stderr : stderr?.toString('utf8') ?? ''
  ).trim()
  return (
    /^can't find session:.*$/i.test(message)
    || /^no server running on.*$/i.test(message)
  )
}

/**
 * Probe tmux without collapsing transport/process failures into "not found".
 *
 * `tmux has-session` uses exit 1 for a normal miss. Spawn failures, timeouts,
 * and signals mean we could not establish backend absence and must propagate
 * so lifecycle cleanup retains its durable recovery evidence.
 */
export async function tmuxHasSessionStrict(tmuxName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', exactTmuxSessionTarget(tmuxName)])
    strictProbeWarnings.delete(tmuxName)
    return true
  } catch (err) {
    const failure = err as {
      code?: string | number
      killed?: boolean
      signal?: NodeJS.Signals | null
      stderr?: string | Buffer
    }
    if (isOrdinaryTmuxSessionMiss(failure, failure.stderr)) {
      strictProbeWarnings.delete(tmuxName)
      return false
    }
    if (!strictProbeWarnings.has(tmuxName)) {
      strictProbeWarnings.add(tmuxName)
      const stderr = (
        typeof failure.stderr === 'string'
          ? failure.stderr
          : failure.stderr?.toString('utf8') ?? ''
      ).trim()
      log.warn(
        'tmux',
        `${tmuxName}: strict liveness probe was inconclusive`
        + `${stderr ? `: ${stderr}` : `: ${(err as Error).message}`}`,
      )
    }
    throw err
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
      const target = exactTmuxSessionTarget(tmuxName)
      await execFileAsync('tmux', ['has-session', '-t', target])

      // Capture pane content
      const stdout = await captureScreen(tmuxName)

      // Look for the dev channel warning prompt
      if (stdout.includes('Enter to confirm')) {
        // Send Enter to accept
        await execFileAsync('tmux', ['send-keys', '-t', exactTmuxPaneTarget(tmuxName), 'Enter'])
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

/** The window interactive sessions draw from, registered once at boot. `findPort`
 *  refuses any OTHER window that overlaps it — see {@link findPort}. Null until
 *  registered, which is the case in unit tests that only exercise one window. */
let interactiveWindow: PortWindow | null = null

/** Declare which window belongs to user-initiated sessions. Called from server
 *  boot with the resolved config; pass `null` to clear (tests). */
export function setInteractivePortWindow(window: PortWindow | null): void {
  interactiveWindow = window
}

export function interactivePortWindow(): PortWindow | null {
  return interactiveWindow
}

/**
 * Claim a free port from `window`.
 *
 * THE OVERLAP REFUSAL is the half of U6's port safety that code enforces rather
 * than documents: any window whose label differs from the registered interactive
 * one may not overlap it. A background refresh fleet therefore cannot reach a port
 * an interactive session could have used, whatever the trigger volume — and a
 * config edit that widened the refresh window into the interactive one fails loudly
 * at the first launch instead of starving user sessions much later.
 */
export async function findPort(window: PortWindow): Promise<number> {
  if (!Number.isInteger(window.start) || !Number.isInteger(window.count) || window.count < 1) {
    throw new Error(`Invalid port window "${window.label}": start=${window.start} count=${window.count}`)
  }
  const last = window.start + window.count - 1
  if (interactiveWindow && window.label !== interactiveWindow.label
    && portWindowsOverlap(window, interactiveWindow)) {
    const iLast = interactiveWindow.start + interactiveWindow.count - 1
    throw new Error(
      `Port window "${window.label}" (${window.start}-${last}) overlaps the interactive window ` +
      `"${interactiveWindow.label}" (${interactiveWindow.start}-${iLast}); the two must be disjoint`,
    )
  }
  for (let port = window.start; port <= last; port++) {
    if (await tryPort(port)) {
      claimedPorts.add(port)
      return port
    }
  }
  throw new Error(`No available port found in window "${window.label}" (${window.start}-${last})`)
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
 * Write the NATS channel config Claude needs at launch. Returns the config path,
 * which the caller passes to `claude --mcp-config <path>`.
 *
 * The file lives in the session's own config dir (next to nats-topics.txt), NOT
 * in the git workspace. Claude Code's --dangerously-load-development-channels
 * server:nats resolver reads the named server straight from --mcp-config as of
 * CC 2.1.201 (verified empirically 2026-07-06; older builds only saw a CWD
 * .mcp.json, which is why this used to be written into the repo). Because the
 * file is now per-session and private, it carries the per-session values as
 * literals — no ${VAR} env-token indirection, no byte-identical churn dance, and
 * nothing written into the user's repo. --mcp-config loads non-strict, so a
 * project's own CWD .mcp.json still loads alongside it.
 */
export function generateNatsMcpConfig(opts: {
  sessionsDir: string
  sessionName: string
  nats: SessionNats
  channelServerPackage: string  // npm package or github:user/repo
  bunPath: string
  jetstream?: boolean
  natsUrl: string
  routerSubject: string
  routerAuth: string
}): string {
  // Per-session topics file (one subject per line) — keeps the variable-length
  // subscription list out of the mcp config. Lives outside the git tree.
  const topicsPath = natsTopicsFilePath(opts.sessionsDir, opts.sessionName)
  const controlSocket = natsControlSocketPath(opts.sessionName)
  mkdirSync(join(opts.sessionsDir, opts.sessionName), { recursive: true })
  writeIfChanged(topicsPath, opts.nats.subscriptions.join('\n') + '\n', 0o600)

  // Literal per-session args — the file is per-session, so there is no reason to
  // route these through env tokens. --control-socket wires up the hot
  // subscription management path used by POST/DELETE
  // /api/sessions/:name/subscriptions. Requires nats-channel-mcp >= the commit
  // that introduced the flag (except-pass/nats-channel-mcp#1).
  const args: string[] = [
    'x', opts.channelServerPackage,
    '--name', opts.sessionName,
    '--nats', opts.natsUrl,
    '--topics-file', topicsPath,
    '--control-socket', controlSocket,
  ]
  if (opts.jetstream) args.push('--jetstream')

  const mcpConfig = {
    mcpServers: {
      nats: {
        command: opts.bunPath,
        args,
        env: {
          [TINSTAR_NATS_URL_ENV]: opts.natsUrl,
          [TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV]: opts.routerSubject,
          [TINSTAR_MESSAGE_ROUTER_AUTH_ENV]: opts.routerAuth,
        },
      },
    },
  }

  // Per-session config dir, outside any git tree. Passed to Claude via
  // --mcp-config so it never has to live in the workspace. Written idempotently.
  const mcpConfigPath = join(opts.sessionsDir, opts.sessionName, 'nats-mcp.json')
  writeIfChanged(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 0o600)
  return mcpConfigPath
}

/** Write only when content differs, so a stable config leaves mtime untouched. */
function writeIfChanged(path: string, content: string, mode: number): void {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) {
    chmodSync(path, mode)
    return
  }
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
}

function managedMessageRouterEnvironment(
  config: TinstarConfig,
  sessionName: string,
  agentIncarnation: string,
): Record<string, string> {
  return {
    [TINSTAR_NATS_URL_ENV]: natsBrokerUrl(),
    [TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV]: messageRouterSubject(config.dirs.root),
    [TINSTAR_MESSAGE_ROUTER_AUTH_ENV]: deriveMessageRouterSessionKey(
      messageRouterMasterKey(config.dirs.root),
      { sessionId: sessionName, incarnation: agentIncarnation },
    ).toString('hex'),
  }
}

async function syncManagedMessageRouterEnvironment(
  tmuxTarget: string,
  environment: Readonly<Record<string, string>> | null,
): Promise<void> {
  for (const name of [
    TINSTAR_NATS_URL_ENV,
    TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV,
    TINSTAR_MESSAGE_ROUTER_AUTH_ENV,
  ]) {
    await execFileAsync('tmux', environment
      ? ['set-environment', '-t', tmuxTarget, name, environment[name]!]
      : ['set-environment', '-t', tmuxTarget, '-r', name])
  }
}

/** Build the agent CLI command from a template or legacy skipPermissions flag. */
export function buildAgentCommand(opts: {
  provider?: TerminalProviderAdapter
  template?: CliTemplate | null
  skipPermissions?: boolean
  sessionId?: string | null
  resume?: boolean
  initialPrompt?: string | null
  /** NATS channel provisioning. When enabled, `mcpConfigPath` is the per-session
   * nats-mcp.json to load via `--mcp-config`; when disabled, the dev-channels
   * flag is stripped from the resolved command (see coupling note below). */
  nats?: { enabled: boolean; mcpConfigPath?: string | null } | null
  appendSystemPrompt?: string | null
  agent?: AgentDef | null
  /** Per-session model override (Switchboard). Appends `--model <modelOverride>`
   * to the resolved command, overriding the template's baked model. Null/absent
   * leaves the command byte-identical to pre-override behavior. */
  modelOverride?: string | null
}): string {
  const provider = opts.provider ?? defaultProviderRegistry.resolveTemplate(opts.template)
  // Option flags that must sit before the ` -- {prompt}` separator. Collected
  // here and spliced in exactly once during assembly below, so a ` -- ` inside
  // any flag *value* — a session-name-derived --mcp-config path, or a prompt /
  // persona that itself contains ' -- ' — can never be mistaken for the real
  // separator (which a per-flag indexOf(' -- ') re-scan would latch onto).
  const preFlags: string[] = []
  let head: string       // command up to (not including) the prompt separator
  let promptTail = ''    // ` -- '<prompt>'` when a one-shot prompt is present

  if (opts.template) {
    const tmpl = opts.resume ? opts.template.resumeCmd : opts.template.startCmd
    const values = {
      sessionId: opts.sessionId,
      prompt: opts.resume ? null : opts.initialPrompt,
      agent: opts.agent,
    }
    // Split the template before interpolating opaque persona/prompt values.
    // Otherwise a literal ` -- ` inside {agentPrompt} looks like the command's
    // prompt boundary and provider flags get inserted into quoted persona text.
    const promptPlaceholder = tmpl.indexOf('{prompt}')
    const separator = promptPlaceholder === -1
      ? -1
      : tmpl.lastIndexOf(' -- ', promptPlaceholder)
    if (separator !== -1) {
      head = interpolateTemplate(tmpl.slice(0, separator), values)
      const interpolatedTail = interpolateTemplate(tmpl.slice(separator), values)
      promptTail = interpolatedTail ? ` ${interpolatedTail}` : ''
    } else {
      head = interpolateTemplate(tmpl, values)
    }
    // Couple the dev-channels flag to the nats-mcp.json that defines the server
    // it names. Templates bake in `--dangerously-load-development-channels
    // server:nats` unconditionally, but the config is only written when NATS is
    // actually provisioned (enabled + subscriptions — see generateNatsMcpConfig
    // callsite). For a blank/standalone session that doesn't hold, so the file is
    // absent and Claude aborts at launch resolving a server that doesn't exist —
    // taking the trailing `-- {prompt}` down with it. Strip the flag whenever
    // NATS wasn't provisioned so the command stays internally consistent, and
    // inject `--mcp-config <path>` when it was so Claude can find the server.
    //
    // The provider capability — not its ID — decides whether this transport can
    // be wired. A future provider can implement a different command strategy
    // without entering shared command-builder conditionals.
    if (opts.nats?.enabled) {
      const nats = requireProviderCapability(provider, 'nats')
      // Templates are user-editable and may or may not bake in the provider's
      // enable flag. Normalize both forms to one provider-owned flag so enabled
      // launches never omit it and legacy multi-agent templates never duplicate
      // it. The disabledPattern belongs to the provider for the same reason the
      // inserted flags do: shared assembly must not know provider CLI syntax.
      head = head.replace(nats.command.disabledPattern, '')
      preFlags.push(...nats.command.launchFlags(opts.nats.mcpConfigPath))
    } else if (provider.terminal.capabilities.nats.state === 'supported') {
      head = head.replace(
        provider.terminal.capabilities.nats.detail.command.disabledPattern,
        '',
      )
    }
    // Only add --append-system-prompt when *this* command didn't already
    // interpolate the persona via an {agent...} placeholder. Decided per-command
    // so asymmetric templates (placeholder in only one of startCmd/resumeCmd)
    // still get the persona exactly once on both create and resume.
    const interpolatedPersona = opts.agent != null && /\{agent(Name|Description|Prompt|Json)\}/.test(tmpl)
    if (opts.appendSystemPrompt && !interpolatedPersona) {
      preFlags.push(`--append-system-prompt ${bashSingleQuote(opts.appendSystemPrompt)}`)
    }
  } else {
    // Legacy fallback: build claude command from flags
    let cmd = 'claude'
    if (opts.skipPermissions) cmd += ' --dangerously-skip-permissions'
    if (opts.resume && opts.sessionId) cmd += ` --resume ${opts.sessionId}`
    else if (opts.sessionId) cmd += ` --session-id ${opts.sessionId}`
    // Add NATS channel support — the dev-channels resolver reads the server from
    // the per-session nats-mcp.json passed via --mcp-config.
    if (opts.nats?.enabled) {
      const nats = requireProviderCapability(provider, 'nats')
      preFlags.push(...nats.command.launchFlags(opts.nats.mcpConfigPath))
    }
    if (opts.appendSystemPrompt) {
      preFlags.push(`--append-system-prompt ${bashSingleQuote(opts.appendSystemPrompt)}`)
    }
    head = cmd
    // Single quotes — they don't expand !, `, $, or anything else.
    if (opts.initialPrompt) promptTail = ` -- ${bashSingleQuote(opts.initialPrompt)}`
  }

  // Per-session model override (Switchboard): append `--model <model>` so the
  // CLI's last-wins flag parsing overrides any model baked into the template.
  if (opts.modelOverride) preFlags.push(`--model ${bashSingleQuote(opts.modelOverride)}`)

  const flags = preFlags.length > 0 ? ' ' + preFlags.join(' ') : ''
  return head + flags + promptTail
}

// --- Tmux operations ---

/**
 * Guest environment for a process that must still find OUR tmux server.
 *
 * tmux resolves its socket path from `TMUX_TMPDIR` (then TMPDIR, then /tmp).
 * That variable is deliberately NOT on the guest allowlist — it is a control
 * knob for the tmux CLI, not something a guest shell needs. But a process we
 * spawn to talk to tmux (the `new` that may start the server, and ttyd, which
 * runs `tmux attach`) has to resolve the SAME socket as every other tmux call
 * in this file — and those inherit the full env. Without this passthrough, a
 * machine with TMUX_TMPDIR set would have Tinstar create sessions on one socket
 * and look for them on another.
 */
function tmuxClientEnv(): Record<string, string> {
  const pass: Record<string, string> = {}
  // BOTH knobs, or these calls resolve a DIFFERENT server than the rest of this
  // module. Every other tmux call here inherits Tinstar's full env; if Tinstar
  // itself runs inside tmux (a dev server started from a pane), $TMUX is set and
  // a client with $TMUX and no -L/-S uses THAT socket, ignoring TMUX_TMPDIR
  // (verified, tmux 3.2a). Passing only TMUX_TMPDIR would create the session on
  // one socket and configure/attach it on another.
  if (process.env.TMUX_TMPDIR) pass.TMUX_TMPDIR = process.env.TMUX_TMPDIR
  if (process.env.TMUX) pass.TMUX = process.env.TMUX
  return guestEnv(pass)
}

/**
 * Strip Tinstar's private runtime config from one tmux session's environment.
 *
 * Reads the server-global environment (which is exactly what a new pane
 * inherits — verified by diffing `show-environment -g` against a live pane's
 * /proc/<pid>/environ) and marks every non-allowlisted name for removal on THIS
 * session with `set-environment -r`.
 *
 * `-r` means "delete this before starting any new process in this session", so:
 *  - windows/panes created from here on come up without it, and
 *  - the pane's EXISTING shell is corrected too, because the launch command
 *    already starts with `eval "$(tmux show-environment -s)"` and `-r` makes
 *    that emit `unset NAME;`.
 *
 * All removals go in ONE tmux invocation using `;` command separators —
 * creating a session already costs ~15 tmux calls and this would otherwise add
 * one per stripped variable.
 *
 * Best-effort: a failure here degrades to the old leaky behavior, which must not
 * take down session creation.
 */
export async function scrubTmuxSessionEnv(
  tmuxName: string,
  sessionName: string,
  /** Extra leading tmux args (e.g. ['-L', socket]). Production passes none —
   * Tinstar uses the default socket. The integration test passes an isolated
   * socket so it can exercise THIS function rather than a replica of it. */
  socketArgs: readonly string[] = [],
  /** Names in TINSTAR'S OWN env — the attribution filter (see tmuxEnvRemovals).
   *  Overridable so tests can express "the Tinstar that started this server",
   *  which is not the test runner's own process. */
  tinstarEnvNames: readonly string[] = Object.keys(process.env),
): Promise<void> {
  try {
    const [globalEnv, sessionEnv] = await Promise.all([
      execFileAsync('tmux', [...socketArgs, 'show-environment', '-g']),
      // Session-scoped entries are DELIBERATE — Tinstar's own injections
      // (TINSTAR_SESSION_NAME, NATS/OTLP vars, per-session secrets) or the
      // user's. `show-environment -t` lists only those, never the inherited
      // global ones, so it is a self-maintaining exclusion set: it covers
      // secrets whose names come from config and can't be hardcoded here.
      //
      // Load-bearing on the RESTART path. When Tinstar itself runs inside a
      // Tinstar session, the global env holds the PARENT's TINSTAR_SESSION_NAME
      // and secrets. Removing those names blindly replaces the child's own
      // session-scoped values with removal markers — verified: the pane then
      // has no TINSTAR_SESSION_NAME at all, destroying the session's identity.
      execFileAsync('tmux', [...socketArgs, 'show-environment', '-t', exactTmuxSessionTarget(tmuxName)]),
    ])
    const injected = parseTmuxEnvNames(sessionEnv.stdout)
    // 4th arg is the ATTRIBUTION filter: only strip what Tinstar itself could
    // have put in the server's global env. When the USER started the tmux
    // server, that global env is their own login environment and none of it is
    // ours to remove. See tmuxEnvRemovals in ../guestEnv.ts.
    const removals = tmuxEnvRemovals(
      parseTmuxEnvNames(globalEnv.stdout), injected, process.platform, tinstarEnvNames,
    )
    if (removals.length === 0) return

    // `=name` is tmux's EXACT-match target syntax. A bare `-t name` matches by
    // prefix, so a session that disappears mid-scrub could let these removals
    // land on a different session whose name starts with the same characters.
    const target = exactTmuxSessionTarget(tmuxName)
    const args: string[] = [...socketArgs]
    for (const name of removals) {
      if (args.length > socketArgs.length) args.push(';')
      args.push('set-environment', '-t', target, '-r', name)
    }
    await execFileAsync('tmux', args)
    log.info('tmux', `${sessionName}: ${describeGuestEnvScoping(removals)}`)
  } catch (err) {
    log.warn('tmux', `${sessionName}: guest env scoping failed, session may inherit Tinstar's env: ${(err as Error).message}`)
  }
}

export async function createTmuxSession(
  config: TinstarConfig,
  opts: {
    session: Session & { initialPrompt?: string }
    secrets: Record<string, string>
    port: number
    provider?: TerminalProviderAdapter
    resume?: boolean
    template?: CliTemplate | null
    appendSystemPrompt?: string | null
    agent?: AgentDef | null
  },
): Promise<{ port: number; ttydPid: number | undefined }> {
  const provider = opts.provider ?? defaultProviderRegistry.resolveTemplate(opts.template)
  const tmuxName = tmuxSessionName(config, opts.session.name)

  const tmuxArgs = ['-f', '/dev/null', 'new', '-d', '-s', tmuxName]
  if (opts.session.workspace?.path) {
    tmuxArgs.push('-c', opts.session.workspace.path)
  }
  // Scoped env, half 1 of 2: when NO tmux server is running yet, THIS call is
  // what starts it — and tmux freezes the starting process's environment as its
  // server-global environment, which every pane it ever creates inherits. Passing
  // Tinstar's own `process.env` here (Node's default) is how NODE_ENV=production
  // from the systemd unit ended up in every agent shell. See ../guestEnv.ts.
  // When a server IS already running this env is simply unused — tmux just talks
  // to the existing socket — so it is safe unconditionally.
  await execFileAsync('tmux', tmuxArgs, { env: tmuxClientEnv() })
  // (Half 2 of 2 — the repair for an already-running server — runs further down,
  // after the deliberate injections below. Order matters: the scrub excludes
  // session-scoped vars, so the injections must already be in place.)

  // Configure tmux
  const tmuxTarget = exactTmuxSessionTarget(tmuxName)
  const tmuxPaneTarget = exactTmuxPaneTarget(tmuxName)
  await execFileAsync('tmux', ['set', '-t', tmuxPaneTarget, 'status', 'off'])
  await execFileAsync('tmux', ['set', '-t', tmuxPaneTarget, 'mouse', 'on'])
  // Ctrl+Backspace: xterm.js sends 0x08 (C-h) — remap to word-erase (C-w)
  await execFileAsync('tmux', ['bind-key', '-n', 'C-h', 'send-keys', 'C-w'])

  // OS-clipboard integration. With `mouse on`, a drag-selection lands only in
  // tmux's internal paste buffer — which never reaches the host clipboard when
  // the terminal is rendered remotely (ttyd in a browser, e.g. over WSL).
  // Enable set-clipboard (OSC-52, for terminals that honor it) and pipe
  // copy-mode selections through the host clipboard tool so drag-select and
  // Enter copy straight to the OS clipboard.
  //
  // SCOPE: tmux runs with no -L/-S socket (see the `new` invocation above), so all
  // Tinstar sessions share the default server — `set -g` and these `bind-key -T`
  // key-table entries are therefore SERVER-GLOBAL, not per-session, and re-applied
  // (idempotently) on each create. This is intentional and matches the existing
  // global `bind-key -n C-h` remap. SECURITY: `set-clipboard on` lets the program
  // inside a pane (the agent CLI) write the host OS clipboard via OSC-52 — a
  // deliberate, low-severity tradeoff for an agent runner.
  await execFileAsync('tmux', ['set', '-g', 'set-clipboard', 'on'])
  const clipboardCmd = getClipboardCommand()
  if (clipboardCmd) {
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      await execFileAsync('tmux', ['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-and-cancel', clipboardCmd])
      await execFileAsync('tmux', ['bind-key', '-T', table, 'Enter', 'send-keys', '-X', 'copy-pipe-and-cancel', clipboardCmd])
    }
  }

  // Inject session identity + secrets into tmux environment
  await execFileAsync('tmux', ['set-environment', '-t', tmuxTarget, 'TINSTAR_SESSION_NAME', opts.session.name])
  const agentIncarnation = randomUUID()
  await execFileAsync('tmux', [
    'set-environment',
    '-t',
    tmuxTarget,
    TINSTAR_AGENT_INCARNATION_ENV,
    agentIncarnation,
  ])
  for (const [key, value] of Object.entries(opts.secrets)) {
    if (value) {
      await execFileAsync('tmux', ['set-environment', '-t', tmuxTarget, key, value])
    }
  }

  const provisionedNats = opts.session.nats?.enabled
    && opts.session.nats.subscriptions.length > 0
    ? requireProviderCapability(provider, 'nats')
    : null
  const messageRouterEnv = provisionedNats
    ? managedMessageRouterEnvironment(config, opts.session.name, agentIncarnation)
    : null
  await syncManagedMessageRouterEnvironment(
    tmuxTarget,
    provisionedNats?.command.forwardServerEnvironment ? messageRouterEnv : null,
  )

  await syncProviderTelemetryEnvironment(
    tmuxTarget,
    opts.session.name,
    provider,
    opts.template,
  )

  // Scoped env, half 2 of 2: repair for an already-running tmux server. The
  // server is long-lived and SHARED (no -L/-S socket — see the SCOPE note
  // above), so one that was started before this fix, or started by something
  // other than Tinstar, still holds a polluted global environment that the
  // scoped env on `tmux new` cannot reach. Strip the private vars for THIS
  // session only, so Tinstar never mutates tmux sessions the user started.
  //
  // Runs AFTER the injections above so they are session-scoped by now and thus
  // excluded from removal. The `eval "$(tmux show-environment -s)"` immediately
  // below then applies the removals to the pane's live shell as `unset NAME;`.
  await scrubTmuxSessionEnv(tmuxName, opts.session.name)

  // Build and send agent command
  const parts = ['eval "$(tmux show-environment -s)"']

  // Generate NATS channel config if enabled — a per-session nats-mcp.json in the
  // session config dir (outside any repo) + per-session topics file, passed to
  // Claude via --mcp-config below. No workspace path required.
  let natsOpts: { enabled: boolean; mcpConfigPath: string } | null = null
  let autoAcceptNatsWarning = false
  if (opts.session.nats?.enabled && opts.session.nats.subscriptions.length > 0) {
    const nats = requireProviderCapability(provider, 'nats')
    const mcpConfigPath = generateNatsMcpConfig({
      sessionsDir: config.dirs.sessions,
      sessionName: opts.session.name,
      nats: opts.session.nats,
      channelServerPackage: config.nats.channelServerPackage,
      bunPath: config.nats.bunPath,
      jetstream: config.nats.jetstream,
      natsUrl: messageRouterEnv![TINSTAR_NATS_URL_ENV]!,
      routerSubject: messageRouterEnv![TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV]!,
      routerAuth: messageRouterEnv![TINSTAR_MESSAGE_ROUTER_AUTH_ENV]!,
    })
    natsOpts = { enabled: true, mcpConfigPath }
    autoAcceptNatsWarning = nats.command.autoAcceptWarning
    log.info('tmux', `${opts.session.name}: NATS enabled, dev channel auto-accept configured`)
  }

  const agentCmd = buildAgentCommand({
    provider,
    template: opts.template,
    skipPermissions: opts.session.skipPermissions,
    sessionId: opts.session.conversation?.id,
    resume: opts.resume,
    initialPrompt: opts.resume ? undefined : opts.session.initialPrompt,
    nats: natsOpts,
    appendSystemPrompt: opts.appendSystemPrompt,
    agent: opts.agent,
    modelOverride: opts.session.modelOverride,
  })
  parts.push(agentCmd)

  // A cursor-agent session hangs on a one-time workspace-trust modal that
  // `--yolo` can't bypass; pre-seed cursor's trust marker so it launches
  // unattended (best-effort — never blocks the launch).
  if (isCursorAgentTemplate(opts.template) && opts.session.workspace?.path) {
    ensureCursorWorkspaceTrust(opts.session.workspace.path)
  }

  await execFileAsync('tmux', ['send-keys', '-t', tmuxPaneTarget, parts.join(' && '), 'Enter'])

  // Auto-accept dev channel warning by polling for the prompt and sending Enter
  // More robust than fixed timeout - waits for actual prompt to appear
  if (natsOpts?.enabled && autoAcceptNatsWarning) {
    autoAcceptDevChannelWarning(tmuxName).catch((err) => {
      log.debug('tmux', `dev-channel auto-accept failed: ${(err as Error).message}`)
    })
  }

  // Start ttyd
  const ttydPid = await startTtyd({ tmuxName, port: opts.port, sessionName: opts.session.name })

  return { port: opts.port, ttydPid }
}

interface StartTmuxSessionDeps {
  reattachTmuxSession: typeof reattachTmuxSession
}

const startTmuxSessionDeps: StartTmuxSessionDeps = { reattachTmuxSession }

export async function startTmuxSession(
  config: TinstarConfig,
  opts: {
    session: Session & { initialPrompt?: string }
    secrets: Record<string, string>
    port: number
    provider?: TerminalProviderAdapter
    template?: CliTemplate | null
    appendSystemPrompt?: string | null
    agent?: AgentDef | null
  },
  deps: StartTmuxSessionDeps = startTmuxSessionDeps,
): Promise<{ port: number; ttydPid: number | undefined }> {
  const provider = opts.provider ?? defaultProviderRegistry.resolveSession(
    opts.session,
    opts.template,
  )
  const tmuxName = tmuxSessionName(config, opts.session.name)
  const exists = await tmuxHasSession(tmuxName)

  if (!exists) {
    return createTmuxSession(config, { ...opts, provider, resume: true })
  }

  // Retrying /start against a live child is idempotent: do not rotate the
  // durable delivery incarnation or inject a second CLI into the same terminal.
  // Re-establish the exact-target terminal surface because the prior ttyd may
  // have exited independently while the agent survived.
  if (await getTmuxAgentIdentity(config, opts.session.name) !== null) {
    return deps.reattachTmuxSession(config, {
      session: opts.session,
      port: opts.port,
    })
  }

  // A restart in the same pane keeps the shell PID, so give every managed
  // agent launch its own tmux-persisted identity before sending the command.
  const agentIncarnation = randomUUID()
  await execFileAsync('tmux', [
    'set-environment',
    '-t',
    exactTmuxSessionTarget(tmuxName),
    TINSTAR_AGENT_INCARNATION_ENV,
    agentIncarnation,
  ])

  const provisionedNats = opts.session.nats?.enabled
    && opts.session.nats.subscriptions.length > 0
    ? requireProviderCapability(provider, 'nats')
    : null
  const messageRouterEnv = provisionedNats
    ? managedMessageRouterEnvironment(config, opts.session.name, agentIncarnation)
    : null
  await syncManagedMessageRouterEnvironment(
    exactTmuxSessionTarget(tmuxName),
    provisionedNats?.command.forwardServerEnvironment ? messageRouterEnv : null,
  )

  // Existing tmux sessions retain session-scoped variables across agent
  // restarts. Reconcile both sides of the policy: inject newly enabled
  // provider telemetry and remove provider-owned variables when disabled.
  await syncProviderTelemetryEnvironment(
    exactTmuxSessionTarget(tmuxName),
    opts.session.name,
    provider,
    opts.template,
  )

  // Re-scrub on restart: a session created before guest-env scoping existed
  // still carries Tinstar's env, and restarting its agent is the one moment we
  // can repair it in place. The `eval "$(tmux show-environment -s)"` below then
  // applies the removals to the pane's live shell as `unset NAME;`.
  await scrubTmuxSessionEnv(tmuxName, opts.session.name)

  // Tmux session exists but agent may have exited — re-send the command
  const parts = ['eval "$(tmux show-environment -s)"']

  // Generate NATS channel config if enabled — see createTmuxSession for details.
  let natsOpts: { enabled: boolean; mcpConfigPath: string } | null = null
  let autoAcceptNatsWarning = false
  if (opts.session.nats?.enabled && opts.session.nats.subscriptions.length > 0) {
    const nats = requireProviderCapability(provider, 'nats')
    const mcpConfigPath = generateNatsMcpConfig({
      sessionsDir: config.dirs.sessions,
      sessionName: opts.session.name,
      nats: opts.session.nats,
      channelServerPackage: config.nats.channelServerPackage,
      bunPath: config.nats.bunPath,
      jetstream: config.nats.jetstream,
      natsUrl: messageRouterEnv![TINSTAR_NATS_URL_ENV]!,
      routerSubject: messageRouterEnv![TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV]!,
      routerAuth: messageRouterEnv![TINSTAR_MESSAGE_ROUTER_AUTH_ENV]!,
    })
    natsOpts = { enabled: true, mcpConfigPath }
    autoAcceptNatsWarning = nats.command.autoAcceptWarning
  }

  const agentCmd = buildAgentCommand({
    provider,
    template: opts.template,
    skipPermissions: opts.session.skipPermissions,
    sessionId: opts.session.conversation?.id,
    resume: true,
    nats: natsOpts,
    appendSystemPrompt: opts.appendSystemPrompt,
    agent: opts.agent,
    modelOverride: opts.session.modelOverride,
  })
  parts.push(agentCmd)
  // Re-seed cursor's workspace trust on restart too (see createTmuxSession).
  if (isCursorAgentTemplate(opts.template) && opts.session.workspace?.path) {
    ensureCursorWorkspaceTrust(opts.session.workspace.path)
  }
  await execFileAsync('tmux', ['send-keys', '-t', exactTmuxPaneTarget(tmuxName), parts.join(' && '), 'Enter'])

  // Same dev-channel auto-accept as createTmuxSession — restarting an exited
  // agent re-shows Claude's NATS warning prompt and must also be accepted.
  if (natsOpts?.enabled && autoAcceptNatsWarning) {
    log.info('tmux', `${opts.session.name}: NATS enabled, dev channel auto-accept configured (restart)`)
    autoAcceptDevChannelWarning(tmuxName).catch((err) => {
      log.debug('tmux', `dev-channel auto-accept failed (restart): ${(err as Error).message}`)
    })
  }

  // Restart ttyd
  const ttydPid = await startTtyd({
    tmuxName,
    port: opts.port,
    sessionName: opts.session.name,
  })
  return { port: opts.port, ttydPid }
}

async function syncProviderTelemetryEnvironment(
  tmuxTarget: string,
  sessionName: string,
  provider: TerminalProviderAdapter,
  template: CliTemplate | null | undefined,
): Promise<void> {
  const commands = providerTelemetryEnvironmentCommands(
    tmuxTarget,
    sessionName,
    provider,
    template,
  )
  for (const args of commands) await execFileAsync('tmux', args)
}

/** Pure telemetry reconciliation plan shared by create and existing-session start. */
export function providerTelemetryEnvironmentCommands(
  tmuxTarget: string,
  sessionName: string,
  provider: TerminalProviderAdapter,
  template: CliTemplate | null | undefined,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
): string[][] {
  const support = provider.terminal.capabilities.telemetry
  if (support.state === 'unsupported') {
    // An explicit opt-in is a configuration error and must still fail fast.
    // With telemetry off (explicitly or by provider default), an unsupported
    // provider has no environment to reconcile.
    if (template?.telemetry === true) requireProviderCapability(provider, 'telemetry')
    return []
  }
  const enabled = providerTelemetryEnabled(provider, template)

  const telemetryVars = support.detail.environment({
    sessionName,
    endpoint,
  })
  return Object.entries(telemetryVars).map(([key, value]) =>
    enabled
      ? ['set-environment', '-t', tmuxTarget, key, value]
      : ['set-environment', '-t', tmuxTarget, '-r', key],
  )
}

export async function stopTmuxSession(
  config: TinstarConfig,
  session: Session,
): Promise<void> {
  stopManagedTtyd(session.name, {
    cancellationReason: 'session stop requested',
  })

  const tmuxName = tmuxSessionName(config, session.name)
  strictProbeWarnings.delete(tmuxName)
  const target = exactTmuxSessionTarget(tmuxName)
  log.info('tmux', `${session.name}: stopping tmux session`, { target })
  try {
    await execFileAsync('tmux', ['kill-session', '-t', target])
  } catch (err) {
    const failure = err as { stderr?: string | Buffer }
    if (!isOrdinaryTmuxSessionMiss(failure, failure.stderr)) throw err
  }
}

export async function deleteTmuxSession(config: TinstarConfig, session: Session): Promise<void> {
  stopManagedTtyd(session.name, {
    cancellationReason: 'session deletion requested',
  })

  const tmuxName = tmuxSessionName(config, session.name)
  strictProbeWarnings.delete(tmuxName)
  const target = exactTmuxSessionTarget(tmuxName)
  log.info('tmux', `${session.name}: deleting tmux session`, { target })
  try {
    await execFileAsync('tmux', ['kill-session', '-t', target])
  } catch (err) {
    const failure = err as { stderr?: string | Buffer }
    if (!isOrdinaryTmuxSessionMiss(failure, failure.stderr)) throw err
  }
}

interface ReattachTmuxSessionDeps {
  incumbentsOnPort: (port: number) => Promise<TtydIncumbent[]>
  verifySurface: typeof verifyTtydSessionSurface
  startTtyd: typeof startTtyd
}

const reattachTmuxSessionDeps: ReattachTmuxSessionDeps = {
  incumbentsOnPort: ttydIncumbentsOnPortStrict,
  verifySurface: verifyTtydSessionSurface,
  startTtyd,
}

export async function reattachTmuxSession(
  config: TinstarConfig,
  opts: { session: Session; port: number },
  deps: ReattachTmuxSessionDeps = reattachTmuxSessionDeps,
): Promise<{ port: number; ttydPid: number | undefined }> {
  const tmuxName = tmuxSessionName(config, opts.session.name)
  // The boot rehydration path has already reclaimed persisted ports, while a
  // freshly allocated port is claimed by findPort(). Do not claim again here:
  // if the lifecycle becomes stale during this await, the caller must be able
  // to release its claim without this helper silently recreating it.

  // Adopt only a ttyd attached to this exact tmux target. A foreign ttyd (or
  // any unrelated HTTP listener) must never make this session look healthy.
  const incumbent = (await deps.incumbentsOnPort(opts.port)).find(
    candidate => candidate.tmuxTarget === tmuxName,
  )
  if (incumbent && await deps.verifySurface({
    port: opts.port,
    pid: incumbent.pid,
    tmuxName,
  }) === 'verified') {
    return { port: opts.port, ttydPid: incumbent.pid }
  }

  const ttydPid = await deps.startTtyd({
    tmuxName,
    port: opts.port,
    sessionName: opts.session.name,
  })
  return { port: opts.port, ttydPid }
}

/** Capture a tmux pane's rendered screen. With `scrollback`, include that many
 *  lines of history (capture-pane -S -<n>). Shared by status detection, the
 *  codex transcript, and the GET /api/sessions/:name/screen endpoint. */
export async function captureScreen(
  tmuxName: string,
  scrollback?: number,
  timeoutMs?: number,
): Promise<string> {
  const args = ['capture-pane', '-t', exactTmuxPaneTarget(tmuxName), '-p']
  if (scrollback && scrollback > 0) args.push('-S', `-${scrollback}`)
  const { stdout } = timeoutMs === undefined
    ? await execFileAsync('tmux', args)
    : await execFileAsync('tmux', args, { timeout: timeoutMs })
  return stdout
}

export async function getTmuxSessionState(config: TinstarConfig, sessionName: string): Promise<'exists' | 'missing'> {
  const tmuxName = tmuxSessionName(config, sessionName)
  const exists = await tmuxHasSessionStrict(tmuxName)
  return exists ? 'exists' : 'missing'
}

/**
 * Stable identity for the managed agent process inside a tmux pane. A launch
 * token stored by tmux survives a Tinstar restart and rotates on every managed
 * relaunch. The child PID and birth time fence manual or unexpected process
 * replacement even when that token does not rotate.
 */
export async function getTmuxAgentIdentity(
  config: TinstarConfig,
  sessionName: string,
): Promise<string | null> {
  const tmuxName = tmuxSessionName(config, sessionName)
  let shellPid: string
  try {
    const { stdout } = await execFileAsync('tmux', [
      'display-message',
      '-p',
      '-t',
      exactTmuxPaneTarget(tmuxName),
      '#{pane_pid}',
    ])
    shellPid = stdout.trim()
    if (!/^\d+$/.test(shellPid)) {
      throw new Error(`tmux returned an invalid shell pid for ${tmuxName}`)
    }
  } catch (error) {
    const failure = error as { stderr?: string | Buffer }
    if (isOrdinaryTmuxSessionMiss(failure, failure.stderr)) return null
    throw error
  }

  let agentPid: string
  try {
    // The pane shell can have unrelated background children. Its foreground
    // process group is the command currently owning the terminal, so use that
    // leader as the managed agent identity rather than accepting the first
    // direct child returned by pgrep.
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'tpgid=', '-p', shellPid],
      { timeout: 2_000 },
    )
    agentPid = stdout.trim()
    if (!/^\d+$/.test(agentPid) || agentPid === shellPid) return null
  } catch (error) {
    if (isCleanInspectionMiss(error)) return null
    throw error
  }

  // Sessions launched before managed tokens existed still use process birth.
  const launchToken = await getTmuxAgentLaunchToken(config, sessionName) ?? ''

  const { stdout: processBirth } = await execFileAsync(
    'ps',
    ['-o', 'lstart=', '-p', agentPid],
    { timeout: 2_000 },
  )
  if (!processBirth.trim()) return null
  const nativeIdentity = JSON.stringify([
    launchToken,
    agentPid,
    processBirth.trim(),
  ])
  return createHash('sha256').update(nativeIdentity).digest('hex')
}

/** Read the private launch token inherited by this session's managed MCPs. */
export async function getTmuxAgentLaunchToken(
  config: TinstarConfig,
  sessionName: string,
): Promise<string | null> {
  const tmuxName = tmuxSessionName(config, sessionName)
  try {
    const { stdout } = await execFileAsync('tmux', [
      'show-environment',
      '-t',
      exactTmuxSessionTarget(tmuxName),
      TINSTAR_AGENT_INCARNATION_ENV,
    ])
    const prefix = `${TINSTAR_AGENT_INCARNATION_ENV}=`
    const environmentLine = stdout.trim()
    if (!environmentLine.startsWith(prefix)) {
      throw new Error(
        `tmux returned an invalid ${TINSTAR_AGENT_INCARNATION_ENV} value for ${tmuxName}`,
      )
    }
    const launchToken = environmentLine.slice(prefix.length)
    if (!launchToken || launchToken.includes('\n') || launchToken.includes('\r')) {
      throw new Error(
        `tmux returned an invalid ${TINSTAR_AGENT_INCARNATION_ENV} value for ${tmuxName}`,
      )
    }
    return launchToken
  } catch (error) {
    const failure = error as {
      code?: string | number
      killed?: boolean
      signal?: NodeJS.Signals | string | null
      stderr?: string | Buffer
    }
    const stderr = (
      typeof failure.stderr === 'string'
        ? failure.stderr
        : failure.stderr?.toString('utf8') ?? ''
    ).trim()
    const variableMissing = (
      (failure.code === 1 || failure.code === '1')
      && failure.killed !== true
      && failure.signal == null
      && stderr === `unknown variable: ${TINSTAR_AGENT_INCARNATION_ENV}`
    )
    if (variableMissing || isOrdinaryTmuxSessionMiss(failure, failure.stderr)) return null
    throw error
  }
}

// --- ttyd management ---

interface ManagedTtydEntry {
  child: ChildProcess
  tmuxName: string
  port: number
  startToken: symbol
  stopped: boolean
  restartTimer?: ReturnType<typeof setTimeout>
  onRestart?: (pid: number) => void
}

const managedTtyd = new Map<string, ManagedTtydEntry>()
const ttydStartTokens = new Map<string, symbol>()
const ttydStartChains = new Map<string, Promise<unknown>>()
const pendingTtydStartTokens = new Map<string, Set<symbol>>()
const ttydStartCancellationReasons = new Map<
  symbol,
  TtydStartCancellationReason
>()

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

/** Exact process/target identity required before publishing a terminal port. */
export function ttydIncumbentMatchesSession(
  incumbents: readonly TtydIncumbent[],
  pid: number | undefined,
  tmuxName: string,
): boolean {
  return pid !== undefined
    && incumbents.some(
      incumbent => incumbent.pid === pid && incumbent.tmuxTarget === tmuxName,
    )
}

/**
 * Extract the tmux session a ttyd attaches from its full `ps -o args=` line.
 * Anchors on the tmux client invocation (`tmux … attach[-session] … -t NAME`),
 * so it tolerates global flags like `-L <socket>` and the `attach-session`
 * alias, and never mistakes ttyd's own `-t` option flags (which precede `tmux`
 * in the args, e.g. `-t titleFixed=Tinstar`) for the session token. Single
 * source for both reclaim paths so the parser can't drift from how `startTtyd`
 * spawns the client (`bash -c "tmux attach -t =<name>"`). Returns null when no
 * tmux target is present (e.g. the process vanished or runs a non-tmux command).
 */
export function tmuxTargetFromArgs(args: string): string | null {
  const m = args.match(/\btmux\b.*?\battach(?:-session)?\b.*?\s-t\s+(\S+)/)
  if (!m) return null
  const target = m[1]!
  return target.startsWith('=') ? target.slice(1) : target
}

let ttydIdentityInspectionState: 'unknown' | 'available' | 'unavailable' = 'unknown'
let ttydIdentityInspectionWarned = false
let ttydIdentityInspectionRetryAt = 0
let ttydIdentityInspectionFailureEpoch = 0
const TTYD_IDENTITY_INSPECTION_RETRY_MS = 30_000

export class TtydIdentityInspectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TtydIdentityInspectionError'
  }
}

export type TtydStartInterruptionStage =
  | 'preflight'
  | 'pre-spawn'
  | 'post-spawn'
  | 'settlement'

export type TtydStartCancellationReason =
  | 'session stop requested'
  | 'session deletion requested'
  | 'reattach inconclusive-surface compensation'
  | 'reattach lifecycle ownership lost'
  | 'reattach unhealthy-surface retirement'
  | 'reattach verification compensation'
  | 'reattach publication compensation'
  | 'reattach failure compensation'
  | 'surface refresh launch compensation'
  | 'surface refresh retirement'
  | `automatic restart abandoned: ${string}`

export class TtydStartSupersededError extends Error {
  constructor(
    sessionName: string,
    readonly stage: TtydStartInterruptionStage,
    options?: ErrorOptions,
  ) {
    super(`ttyd start for ${sessionName} was superseded at ${stage}`, options)
    this.name = 'TtydStartSupersededError'
  }
}

function describeTtydInterruptionForMessage(interrupted: unknown): string {
  try {
    return describeTtydFailure(interrupted)
  } catch {
    return '[interruption diagnostic unavailable]'
  }
}

export class TtydStartCancelledError
  extends Error
  implements NonCausalInterruptionError {
  readonly diagnosticSummary: string
  readonly [TTYD_NON_CAUSAL_INTERRUPTION] = true as const

  constructor(
    sessionName: string,
    /** Boundary stage inherited from the supersession this cancellation replaces. */
    readonly stage: TtydStartInterruptionStage,
    /** Lifecycle action that removed ownership of this start. */
    readonly reason: TtydStartCancellationReason,
    /** Primary diagnostic: the original failure, outside `cause` so it cannot imply supersession. */
    readonly interrupted: unknown,
    /** Reserved for an additional failure while cleaning up the interrupted start. */
    options?: ErrorOptions,
  ) {
    const summary =
      `ttyd start for ${sessionName} was cancelled at ${stage}`
      + `; cancellation reason: ${reason}`
    super(
      summary + '; interrupted failure: '
        + describeTtydInterruptionForMessage(interrupted),
      options,
    )
    this.name = 'TtydStartCancelledError'
    this.diagnosticSummary = summary
  }
}

export class TtydStartCancellationReceiptError
  extends Error
  implements NonCausalInterruptionError {
  readonly diagnosticSummary: string
  readonly [TTYD_NON_CAUSAL_INTERRUPTION] = true as const

  constructor(
    sessionName: string,
    /** Original interruption kept non-causal so supersession cannot be inferred. */
    readonly interrupted: unknown,
    /** Optional cleanup aggregate; its sibling errors remain non-causal. */
    options?: ErrorOptions,
  ) {
    const summary =
      `ttyd start for ${sessionName} lost ownership without a cancellation receipt`
    super(
      summary + '; interrupted failure: '
        + describeTtydInterruptionForMessage(interrupted),
      options,
    )
    this.name = 'TtydStartCancellationReceiptError'
    this.diagnosticSummary = summary
  }
}

export function findTtydStartSupersededError(
  err: unknown,
): TtydStartSupersededError | null {
  return findTtydStartCause(
    err,
    (candidate): candidate is TtydStartSupersededError =>
      candidate instanceof TtydStartSupersededError,
  )
}

function findTtydStartCause<T extends Error>(
  err: unknown,
  matches: (candidate: Error) => candidate is T,
): T | null {
  // Adapter and lifecycle boundaries may each preserve a failure as `cause`,
  // so walk the complete native cause chain. The Set deliberately terminates
  // malformed cycles. AggregateError siblings are not causal wrappers and are
  // intentionally outside both interruption classifiers: cancellation cleanup
  // aggregates contain a supersession sibling that must stay non-causal.
  const seen = new Set<Error>()
  let candidate = err
  while (candidate instanceof Error && !seen.has(candidate)) {
    if (matches(candidate)) return candidate
    seen.add(candidate)
    candidate = candidate.cause
  }
  return null
}

function markTtydIdentityInspectionAvailable(
  probeFailureEpoch: number,
): void {
  // A success that began before a newer failure is stale evidence and must
  // not clear the newer cooldown.
  if (ttydIdentityInspectionFailureEpoch !== probeFailureEpoch) return
  ttydIdentityInspectionState = 'available'
  ttydIdentityInspectionRetryAt = 0
  ttydIdentityInspectionWarned = false
}

function markTtydIdentityInspectionUnavailable(): void {
  ttydIdentityInspectionFailureEpoch += 1
  ttydIdentityInspectionState = 'unavailable'
  ttydIdentityInspectionRetryAt = Date.now()
    + TTYD_IDENTITY_INSPECTION_RETRY_MS
}

/** Whether strict identity inspection is in a non-destructive retry cooldown. */
export function ttydIdentityInspectionUnavailable(): boolean {
  return (
    ttydIdentityInspectionState === 'unavailable'
    && Date.now() < ttydIdentityInspectionRetryAt
  )
}

interface IdentityExecFailure {
  code?: string | number
  stdout?: string | Buffer
  stderr?: string | Buffer
  killed?: boolean
  signal?: NodeJS.Signals | null
}

type IdentityExec = (
  file: string,
  args: readonly string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>

function inspectionOutput(value: string | Buffer | undefined): string {
  return typeof value === 'string'
    ? value.trim()
    : value?.toString('utf8').trim() ?? ''
}

/**
 * lsof/pgrep/ps use exit 1 with no diagnostics for an ordinary empty match.
 * Anything with diagnostics, a signal, or a forced kill is infrastructure
 * failure and must remain inconclusive.
 */
export function isCleanInspectionMiss(err: unknown): boolean {
  const failure = err as IdentityExecFailure
  return (
    (failure.code === 1 || failure.code === '1')
    && inspectionOutput(failure.stdout) === ''
    && inspectionOutput(failure.stderr) === ''
    && failure.killed !== true
    && failure.signal == null
  )
}

async function inspectTtydPid(
  pid: number,
  run: IdentityExec,
): Promise<TtydIncumbent | null> {
  let comm: string
  try {
    comm = (await run(
      'ps',
      ['-o', 'comm=', '-p', String(pid)],
      { timeout: 2_000 },
    )).stdout
  } catch (err) {
    if (isCleanInspectionMiss(err)) return null
    throw err
  }
  if (basename(comm.trim()) !== 'ttyd') return null

  try {
    const { stdout: args } = await run(
      'ps',
      ['-o', 'args=', '-p', String(pid)],
      { timeout: 2_000 },
    )
    return { pid, tmuxTarget: tmuxTargetFromArgs(args) }
  } catch (err) {
    if (isCleanInspectionMiss(err)) return null
    throw err
  }
}

/** Strict, bounded host inspection without global retry/circuit state. */
export async function inspectTtydIncumbentsOnPort(
  port: number,
  run: IdentityExec = execFileAsync,
): Promise<TtydIncumbent[]> {
  let stdout: string
  try {
    stdout = (await run(
      'lsof',
      ['-w', '-ti', `:${port}`],
      { timeout: 2_000 },
    )).stdout
  } catch (err) {
    if (isCleanInspectionMiss(err)) return []
    throw err
  }

  const pids = stdout
    .split('\n')
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0)
  const inspected = await Promise.all(pids.map(pid => inspectTtydPid(pid, run)))
  return inspected.filter((entry): entry is TtydIncumbent => entry !== null)
}

/**
 * Async, strict counterpart used by periodic readiness verification.
 * Exit 1 with no output means the port has no listeners; every other lsof
 * or ps failure is inconclusive. Failures enter a cooldown so a misconfigured
 * service cannot thrash, while later boundaries can recover from a transient.
 */
export async function ttydIncumbentsOnPortStrict(
  port: number,
  run: IdentityExec = execFileAsync,
): Promise<TtydIncumbent[]> {
  if (ttydIdentityInspectionUnavailable()) {
    throw new TtydIdentityInspectionError(
      'terminal identity inspection is in retry cooldown',
    )
  }
  const probeFailureEpoch = ttydIdentityInspectionFailureEpoch
  try {
    const incumbents = await inspectTtydIncumbentsOnPort(port, run)
    markTtydIdentityInspectionAvailable(probeFailureEpoch)
    return incumbents
  } catch (err) {
    markTtydIdentityInspectionUnavailable()
    throw new TtydIdentityInspectionError(
      `terminal identity inspection failed: ${(err as Error).message}`,
      { cause: err },
    )
  }
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

export async function inspectAllTtydIncumbents(
  run: IdentityExec = execFileAsync,
): Promise<TtydIncumbent[]> {
  let stdout: string
  try {
    stdout = (await run('pgrep', ['-x', 'ttyd'], { timeout: 2_000 })).stdout
  } catch (err) {
    if (isCleanInspectionMiss(err)) return []
    throw err
  }
  const pids = stdout
    .split('\n')
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0)
  const inspected = await Promise.all(pids.map(pid => inspectTtydPid(pid, run)))
  return inspected.filter((entry): entry is TtydIncumbent => entry !== null)
}

/**
 * Every ttyd process on the machine, inspected asynchronously with timeouts
 * and the same cooldown used by the port-scoped strict probe.
 */
export async function allTtydIncumbentsStrict(
  run: IdentityExec = execFileAsync,
): Promise<TtydIncumbent[]> {
  if (ttydIdentityInspectionUnavailable()) {
    throw new TtydIdentityInspectionError(
      'terminal identity inspection is in retry cooldown',
    )
  }
  const probeFailureEpoch = ttydIdentityInspectionFailureEpoch
  try {
    const incumbents = await inspectAllTtydIncumbents(run)
    markTtydIdentityInspectionAvailable(probeFailureEpoch)
    return incumbents
  } catch (err) {
    markTtydIdentityInspectionUnavailable()
    throw new TtydIdentityInspectionError(
      `terminal process inspection failed: ${(err as Error).message}`,
      { cause: err },
    )
  }
}

/**
 * Pids of ttyds attached to EXACTLY our tmux session, regardless of which port
 * they listen on. These are stale ttyds from a previous backend lifecycle that
 * the port-scoped reclaim (ttydPidsToReclaim) misses: when a backend restart
 * re-assigns this session a *different* port, the previous ttyd is orphaned on
 * its old port still attached to the same tmux session, and accumulates one per
 * restart. Multiple ttyds on one session double-attach it; with
 * `window-size latest` that makes the terminal resize-churn between clients.
 *
 * Exact match (not prefix) is load-bearing: reclaiming "tinstar-foo" must never
 * kill the ttyd for a child hand session "tinstar-foo-reviewer-ab12". Same-name
 * matches are assumed to be ours — two backends serving the same tmux session
 * name is the unsupported config collision that TINSTAR_CONFIG_HOME prevents.
 */
export function ttydPidsForSession(incumbents: TtydIncumbent[], ourTmuxName: string): number[] {
  return incumbents.filter((inc) => inc.tmuxTarget === ourTmuxName).map((inc) => inc.pid)
}

/**
 * Global GC: pids of ttyds that are squatting a port for a tmux session that no
 * longer exists. These accumulate one-per-restart — when the backend dies its
 * ttyds reparent to `systemd --user` and keep listening forever, eventually
 * exhausting the 100-port pool (`No available port found`). The per-session
 * reclaim in `startTtyd` never sees them because they belong to no session the
 * backend is (re)starting.
 *
 * The predicate is "tmux session is DEAD", never "not in my tracked set":
 *  - A live tmux is in use — keep it regardless of which backend spawned it. A
 *    second backend on a different TINSTAR_CONFIG_HOME serves live tmux sessions
 *    this backend never tracked; reaping those is the cross-backend kill-war.
 *  - Only `prefix`-matched (our `tinstar-*`) targets are eligible, so the user's
 *    own unrelated ttyd (`ttyd … tmux attach -t my-notes`, or `ttyd htop` with a
 *    null target) is never touched.
 *
 * Pure so it can be unit-tested without spawning ttyd; `reapOrphanTtyds` wires
 * it to live process/tmux enumeration.
 */
export function orphanTtydPidsToReap(
  incumbents: TtydIncumbent[],
  liveTmuxNames: Set<string>,
  prefix: string,
): number[] {
  return incumbents
    .filter((inc) =>
      inc.tmuxTarget !== null &&
      inc.tmuxTarget.startsWith(prefix) &&
      !liveTmuxNames.has(inc.tmuxTarget),
    )
    .map((inc) => inc.pid)
}

/**
 * All live tmux session names, or `null` if liveness couldn't be established.
 *
 * The `null` is load-bearing: an *empty* set means "tmux has no sessions" (a
 * real signal — every tinstar ttyd is then a squatter), but a *failed* tmux
 * call must NOT be read as "everything is dead" or the sweep would kill every
 * live session's ttyd. `tmux list-sessions` exits 1 with "no server running"
 * when there genuinely are zero sessions — that case alone maps to the empty
 * set; any other failure returns null so the caller skips the sweep.
 */
async function listLiveTmuxSessionNames(): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}'])
    return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    return /no server running/i.test(msg) ? new Set() : null
  }
}

/**
 * One pass of the orphan-ttyd GC: SIGTERM every ttyd squatting a port for a
 * dead `prefix`-matched tmux session. Returns how many were reaped. Wired to
 * run at startup (after reattach) and on the periodic reconcile tick so the
 * port pool drains continuously and the user never hits "No available port".
 */
export async function reapOrphanTtyds(prefix: string): Promise<number> {
  const live = await listLiveTmuxSessionNames()
  if (live === null) return 0 // liveness unknown — never risk killing live ttyds
  let incumbents: TtydIncumbent[]
  try {
    // GC is best-effort and already fails safe. Keep its probe outside the
    // shared user-facing cooldown so a background pgrep/ps timeout cannot
    // reject terminal creation or readiness verification for 30 seconds.
    incumbents = await inspectAllTtydIncumbents()
  } catch (err) {
    log.warn(
      'ttyd',
      `orphan sweep skipped because process inspection failed: ${(err as Error).message}`,
    )
    return 0
  }
  const pids = orphanTtydPidsToReap(incumbents, live, prefix)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
  }
  if (pids.length > 0) {
    log.info('ttyd', `orphan sweep: reaped ${pids.length} port-squatting ttyd(s) with no live tmux session`)
  }
  return pids.length
}

export interface StartTtydOptions {
  tmuxName: string
  port: number
  sessionName: string
}

export interface StartTtydAttemptDeps {
  incumbentsOnPort: (port: number) => Promise<TtydIncumbent[]>
  allIncumbents: () => Promise<TtydIncumbent[]>
  stopManaged: typeof stopManagedTtyd
  killProcess: (pid: number) => void
  spawnProcess: (opts: StartTtydOptions) => ChildProcess
  schedule: typeof setTimeout
  tmuxAlive: (tmuxName: string) => Promise<boolean>
  enqueueRestart: (
    opts: StartTtydOptions,
    startToken: symbol,
  ) => Promise<number | undefined>
}

const startTtydAttemptDeps: StartTtydAttemptDeps = {
  incumbentsOnPort: ttydIncumbentsOnPortStrict,
  allIncumbents: allTtydIncumbentsStrict,
  stopManaged: stopManagedTtyd,
  killProcess: pid => process.kill(pid, 'SIGTERM'),
  spawnProcess: opts => spawn('ttyd', [
    '-W',
    '-p', String(opts.port),
    '-t', 'titleFixed=Tinstar',
    '-t', 'theme={"background":"#000000"}',
    'bash', '-c', `tmux attach -t ${exactTmuxSessionTarget(opts.tmuxName)}`,
  ], {
    stdio: 'ignore',
    env: tmuxClientEnv(),
  }),
  schedule: setTimeout,
  tmuxAlive: tmuxHasSession,
  enqueueRestart: enqueueTtydStart,
}

function enqueueTtydStart(
  opts: StartTtydOptions,
  startToken: symbol,
  deps: StartTtydAttemptDeps = startTtydAttemptDeps,
): Promise<number | undefined> {
  const pendingForSession = pendingTtydStartTokens.get(opts.sessionName)
    ?? new Set<symbol>()
  pendingForSession.add(startToken)
  pendingTtydStartTokens.set(opts.sessionName, pendingForSession)
  const isCurrent = () =>
    ttydStartTokens.get(opts.sessionName) === startToken
  let mutated = false
  const trackedDeps: StartTtydAttemptDeps = {
    ...deps,
    stopManaged: (...args) => {
      mutated = true
      return deps.stopManaged(...args)
    },
  }
  const attempt = serializeByKey(ttydStartChains, opts.sessionName, async () => {
    try {
      return await startTtydForTokenAttempt(
        opts,
        startToken,
        isCurrent,
        trackedDeps,
      )
    } catch (err) {
      // A newer request can arrive while this task is rejecting. Classify at
      // the serialized public settlement boundary so stale generic child
      // errors cannot make background compensation invalidate the queued
      // winner's token.
      if (isCurrent()) throw err
      const replacementPending = ttydStartTokens.has(opts.sessionName)
      const superseded = findTtydStartSupersededError(err)
      let cleanupError: unknown
      if (mutated) {
        // T1 may have killed its incumbent and spawned a child before failing.
        // Remove only T1's managed surface without changing the token.
        try {
          deps.stopManaged(
            opts.sessionName,
            { resetHistory: false, invalidateStarts: false },
          )
          log.info(
            'ttyd',
            `${opts.sessionName}: removed stale `
              + `${replacementPending ? 'superseded' : 'cancelled'} start surface`,
          )
        } catch (cleanupErr) {
          // Production cleanup is currently noexcept. Keep this containment
          // because the dependency seam is injectable and a future cleanup
          // change must not expose a generic error across a replacement token.
          log.warn(
            'ttyd',
            `${opts.sessionName}: stale start cleanup failed: `
              + `${(cleanupErr as Error).message}`,
          )
          cleanupError = cleanupErr
        }
      }
      const combinedFailure = cleanupError === undefined
        ? null
        : new AggregateError(
            [err, cleanupError],
            `stale ttyd start cleanup failed for ${opts.sessionName}`,
          )
      if (!replacementPending) {
        if (superseded) {
          const cancellationReason = ttydStartCancellationReasons.get(startToken)
          if (!cancellationReason) {
            throw new TtydStartCancellationReceiptError(
              opts.sessionName,
              err,
              combinedFailure ? { cause: combinedFailure } : undefined,
            )
          }
          throw new TtydStartCancelledError(
            opts.sessionName,
            superseded.stage,
            cancellationReason,
            err,
            combinedFailure ? { cause: combinedFailure } : undefined,
          )
        }
        if (combinedFailure) throw combinedFailure
        throw err
      }
      if (superseded && !combinedFailure) throw err
      throw new TtydStartSupersededError(
        opts.sessionName,
        superseded?.stage ?? 'settlement',
        { cause: combinedFailure ?? err },
      )
    }
  })
  return attempt.finally(() => {
    const pending = pendingTtydStartTokens.get(opts.sessionName)
    if (pending?.delete(startToken)) {
      ttydStartCancellationReasons.delete(startToken)
      if (pending.size === 0) pendingTtydStartTokens.delete(opts.sessionName)
    }
  })
}

/**
 * Latest-request-wins, per-session serialized ttyd launch.
 *
 * A superseded attempt rejects instead of reporting a false success with no
 * PID. Public create/start callers hold exclusive lifecycle ownership and must
 * propagate that cancellation; background reattach explicitly translates it
 * into a non-destructive retry at the next boundary.
 */
export function startTtyd(
  opts: StartTtydOptions,
): Promise<number | undefined> {
  return startTtydWithDeps(opts, startTtydAttemptDeps)
}

/** Internal dependency seam for deterministic lifecycle concurrency tests. */
export function startTtydWithDeps(
  opts: StartTtydOptions,
  deps: StartTtydAttemptDeps,
): Promise<number | undefined> {
  const startToken = Symbol(opts.sessionName)
  ttydStartTokens.set(opts.sessionName, startToken)
  return enqueueTtydStart(opts, startToken, deps)
}

export async function startTtydForTokenAttempt(
  opts: StartTtydOptions,
  startToken: symbol,
  isCurrent: () => boolean,
  deps: StartTtydAttemptDeps = startTtydAttemptDeps,
): Promise<number | undefined> {
  if (!isCurrent()) {
    throw new TtydStartSupersededError(opts.sessionName, 'preflight')
  }

  // Resolve both inventories before taking any destructive action. Operational
  // lsof/pgrep/ps failures therefore abort this attempt without killing a
  // surface whose identity we could not prove.
  let portIncumbents: TtydIncumbent[]
  let allIncumbents: TtydIncumbent[]
  try {
    [portIncumbents, allIncumbents] = await Promise.all([
      deps.incumbentsOnPort(opts.port),
      deps.allIncumbents(),
    ])
  } catch (err) {
    if (err instanceof TtydIdentityInspectionError) throw err
    throw new TtydIdentityInspectionError(
      `terminal process inspection failed: ${(err as Error).message}`,
      { cause: err },
    )
  }
  if (!isCurrent()) {
    throw new TtydStartSupersededError(opts.sessionName, 'pre-spawn')
  }

  // resetHistory:false — preserve the restart-rate history across an
  // auto-restart so the circuit breaker can count cumulative restarts.
  deps.stopManaged(
    opts.sessionName,
    { resetHistory: false, invalidateStarts: false },
  )

  // Reclaim the port from an orphaned ttyd (e.g. after a server restart), but
  // ONLY from our own previous ttyd or one we can't identify. Killing a ttyd
  // that serves a *different* live session is the kill-war: each session's
  // startTtyd kills the other's ttyd, both auto-restart, and the proxy /s/{name}
  // flaps between the two terminals. If a foreign session holds the port we
  // leave it alone and let the bind fail — the circuit breaker then backs off
  // instead of warring.
  const { kill, foreign } = ttydPidsToReclaim(portIncumbents, opts.tmuxName)
  for (const pid of kill) {
    try { deps.killProcess(pid) } catch { /* already dead */ }
  }
  if (foreign.length > 0) {
    log.warn('ttyd', `${opts.sessionName}: port ${opts.port} held by another session (${foreign.map(f => f.tmuxTarget).join(', ')}); not killing it`)
  }

  // Also reclaim across ALL ports: a backend restart can land this session on a
  // different port, orphaning the previous ttyd (still attached to the same
  // tmux session) on its old port. The port-scoped pass above only sees the new
  // port, so those orphans pile up — one per restart — and double-attach the
  // session. Exact session match so a child hand session is never swept in.
  const portKills = new Set(kill)
  const staleSessionPids = ttydPidsForSession(allIncumbents, opts.tmuxName)
    .filter(pid => !portKills.has(pid))
  if (staleSessionPids.length > 0) {
    log.info('ttyd', `${opts.sessionName}: reaping ${staleSessionPids.length} stale ttyd(s) on other ports for ${opts.tmuxName}`)
    for (const pid of staleSessionPids) {
      try { deps.killProcess(pid) } catch { /* already dead */ }
    }
  }

  return new Promise((resolve, reject) => {
    // ttyd is a guest boundary twice over: it is the tmux CLIENT that attaches
    // the session and a user can drop to a shell inside it. The default
    // spawnProcess therefore uses tmuxClientEnv rather than the server env.
    const child = deps.spawnProcess(opts)

    child.on('error', reject)

    // Auto-restart on unexpected exit — but only when it's actually warranted.
    // Bare unconditional restart spins forever when the tmux target is gone
    // (closed session) or when something keeps killing ttyd on a contended
    // port (a second backend on the same config dir). See shouldRestartTtyd.
    child.on('exit', (code) => {
      const entry = managedTtyd.get(opts.sessionName)
      if (
        !entry
        || entry.child !== child
        || entry.startToken !== startToken
        || entry.stopped
        || !isCurrent()
      ) return
      void deps.tmuxAlive(opts.tmuxName).then((tmuxAlive) => {
        const cur = managedTtyd.get(opts.sessionName)
        if (
          !cur
          || cur !== entry
          || cur.child !== child
          || cur.startToken !== startToken
          || cur.stopped
          || !isCurrent()
        ) return
        const now = Date.now()
        const history = (ttydRestartHistory.get(opts.sessionName) ?? []).filter(
          (t) => now - t < TTYD_RESTART_WINDOW_MS,
        )
        const decision = shouldRestartTtyd({ tmuxAlive, restartTimestamps: history, now })
        if (!decision.restart) {
          log.info('ttyd', `${opts.sessionName}: exited (code ${code}), not restarting (${decision.reason})`)
          managedTtyd.delete(opts.sessionName)
          if (ttydStartTokens.get(opts.sessionName) === startToken) {
            invalidateTtydStarts(
              opts.sessionName,
              `automatic restart abandoned: ${decision.reason}`,
            )
          }
          ttydRestartHistory.delete(opts.sessionName)
          return
        }
        log.info('ttyd', `${opts.sessionName}: exited (code ${code}), restarting in 2s...`)
        cur.restartTimer = deps.schedule(() => {
          if (
            managedTtyd.get(opts.sessionName) !== cur
            || cur.stopped
            || !isCurrent()
          ) return
          ttydRestartHistory.set(opts.sessionName, [...history, Date.now()])
          deps.enqueueRestart(opts, startToken).then(pid => {
            if (!isCurrent()) return
            log.info('ttyd', `${opts.sessionName}: restarted`, { pid })
            const restarted = managedTtyd.get(opts.sessionName)
            if (restarted?.startToken === startToken) {
              restarted.onRestart = cur.onRestart
            }
            if (cur.onRestart && pid) cur.onRestart(pid)
          }).catch(err => {
            if (isExpectedTtydStartInterruption(err)) return
            log.error('ttyd', `${opts.sessionName}: restart failed`, {
              error: describeTtydFailure(err),
            })
          })
        }, 2000)
      })
    })

    managedTtyd.set(opts.sessionName, {
      child,
      tmuxName: opts.tmuxName,
      port: opts.port,
      startToken,
      stopped: false,
    })

    // Give ttyd a moment to bind the port
    deps.schedule(() => {
      if (!isCurrent()) {
        reject(new TtydStartSupersededError(opts.sessionName, 'post-spawn'))
        return
      }
      resolve(child.pid)
    }, 500)
  })
}

export function isExpectedTtydStartInterruption(err: unknown): boolean {
  return err instanceof TtydStartSupersededError
    || err instanceof TtydStartCancelledError
}

export function stopManagedTtyd(
  sessionName: string,
  opts:
    | {
        resetHistory?: boolean
        invalidateStarts?: true
        cancellationReason: TtydStartCancellationReason
      }
    | {
        resetHistory?: boolean
        invalidateStarts: false
        cancellationReason?: never
      },
): void {
  if (opts.invalidateStarts !== false) {
    invalidateTtydStarts(sessionName, opts.cancellationReason)
  }
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

function invalidateTtydStarts(
  sessionName: string,
  reason: TtydStartCancellationReason,
): void {
  const pending = pendingTtydStartTokens.get(sessionName)
  if (pending) {
    for (const token of pending) {
      // The first invalidation removed ownership. Later compensation steps
      // (for example refresh retirement followed by tmux deletion) must not
      // rewrite that receipt while the same start is still settling.
      if (!ttydStartCancellationReasons.has(token)) {
        ttydStartCancellationReasons.set(token, reason)
      }
    }
  }
  ttydStartTokens.delete(sessionName)
}

/** Test-only fault injection for one session's otherwise unreachable invariant. */
export function clearTtydStartCancellationReasonForTests(
  sessionName: string,
): void {
  const pending = pendingTtydStartTokens.get(sessionName)
  if (!pending) return
  for (const token of pending) ttydStartCancellationReasons.delete(token)
}

export function onTtydRestart(sessionName: string, callback: (pid: number) => void): void {
  const entry = managedTtyd.get(sessionName)
  if (entry) entry.onRestart = callback
}

export function managedTtydPort(sessionName: string): number | null {
  return managedTtyd.get(sessionName)?.port ?? null
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
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', exactTmuxPaneTarget(tmuxName), '#{pane_id}'])
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

async function doSendKeys(tmuxName: string, keys: string[]): Promise<void> {
  await exitAnyMode(tmuxName)
  await execFileAsync('tmux', ['send-keys', '-t', exactTmuxPaneTarget(tmuxName), ...keys])
}

// Per-session send queue (keyed by tmux session name). A prompt is delivered in
// three steps (send-keys text → settle → send-keys Enter); two of those racing on
// the SAME session interleave into a garbled prompt. Serializing here lets callers
// fan out freely (a Slate refresh-all, concurrent reply/compose/explain) while each
// session's keystrokes stay intact. Different sessions still send in parallel.
const sendChains = new Map<string, Promise<unknown>>()

export interface SerializedSessionInput {
  captureScreen(scrollback?: number): Promise<string>
  /** Run the last safety check, then submit text and Enter under one input lock. */
  submitPrompt(prompt: string, beforeEnter?: () => Promise<boolean>): Promise<boolean>
}

/**
 * Run a terminal-input transaction under the same per-session lock used by
 * every prompt and key injection. Provider adapters use this to keep pane
 * inspection and the resulting keystrokes in one critical section.
 */
export function withSessionInput<T>(
  config: TinstarConfig,
  sessionName: string,
  operation: (input: SerializedSessionInput) => Promise<T>,
): Promise<T> {
  const tmuxName = tmuxSessionName(config, sessionName)
  return serializeByKey(sendChains, tmuxName, () => operation({
    captureScreen: scrollback => captureScreen(tmuxName, scrollback),
    submitPrompt: (prompt, beforeEnter) => doSendPrompt(tmuxName, prompt, beforeEnter),
  }))
}

export function sendKeys(config: TinstarConfig, sessionName: string, keys: string[]): Promise<void> {
  const tmuxName = tmuxSessionName(config, sessionName)
  return serializeByKey(sendChains, tmuxName, () => doSendKeys(tmuxName, keys))
}

export function sendPrompt(config: TinstarConfig, sessionName: string, prompt: string): Promise<void> {
  return withSessionInput(config, sessionName, async input => {
    await input.submitPrompt(prompt)
  })
}

async function doSendPrompt(
  tmuxName: string,
  prompt: string,
  beforeEnter?: () => Promise<boolean>,
): Promise<boolean> {
  // The pane enters copy-mode when the user scrolls in the ttyd terminal.
  // While in copy-mode (or a nested sub-prompt like search/jump), send-keys
  // text goes to the mode handler instead of the underlying process — which
  // is how a prompt starting with 'F' silently triggers "jump backward".
  await exitAnyMode(tmuxName)
  const target = exactTmuxPaneTarget(tmuxName)
  if (beforeEnter) {
    if (!await beforeEnter()) return false
  }
  await execFileAsync('tmux', ['send-keys', '-t', target, prompt, ''])
  await new Promise(r => setTimeout(r, 300))
  await execFileAsync('tmux', ['send-keys', '-t', target, '', 'Enter'])
  return true
}

export async function healthCheck(port: number, opts: { timeout?: number; interval?: number } = {}): Promise<boolean> {
  const { timeout = 5000, interval = 500 } = opts
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(
        `http://localhost:${port}/`,
        { signal: controller.signal },
      )
      if (response.ok) return true
    } catch {
      // Not ready yet
    } finally {
      clearTimeout(abortTimer)
    }
    const delay = Math.min(interval, Math.max(0, deadline - Date.now()))
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
  }
  return false
}

interface TtydSurfaceVerificationDeps {
  incumbentsOnPort: (port: number) => Promise<TtydIncumbent[]>
  healthCheck: typeof healthCheck
}

/**
 * Prove both sides of the terminal surface: the listening process is the
 * expected PID attached to the exact tmux session, and its HTTP endpoint is
 * ready. Recheck process identity after the await so an exit/rebind cannot
 * smuggle a foreign listener through the readiness gate.
 */
export async function verifyTtydSessionSurface(
  opts: {
    port: number
    pid: number | undefined
    tmuxName: string
    timeout?: number
    interval?: number
  },
  deps: TtydSurfaceVerificationDeps = {
    incumbentsOnPort: ttydIncumbentsOnPortStrict,
    healthCheck,
  },
): Promise<'verified' | 'unhealthy' | 'inconclusive'> {
  // Readiness is the slow side of startup. Wait for ttyd to bind before asking
  // lsof which process owns the socket, avoiding a race with startTtyd's
  // intentionally short spawn delay.
  if (!await deps.healthCheck(
    opts.port,
    { timeout: opts.timeout, interval: opts.interval },
  )) return 'unhealthy'
  try {
    const incumbents = await deps.incumbentsOnPort(opts.port)
    return ttydIncumbentMatchesSession(
      incumbents,
      opts.pid,
      opts.tmuxName,
    ) ? 'verified' : 'unhealthy'
  } catch (err) {
    if (!ttydIdentityInspectionWarned) {
      ttydIdentityInspectionWarned = true
      log.warn(
        'ttyd',
        `terminal identity verification is unavailable: ${(err as Error).message}`,
      )
    }
    return 'inconclusive'
  }
}
