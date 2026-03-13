import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { Session } from '../session'
import type { TinstarConfig, ImageProfile } from '../config'

const execFileAsync = promisify(execFile)

// --- Helpers ---

/** Read profiles fresh from disk (config object is frozen at startup). */
function freshProfiles(config: TinstarConfig): ImageProfile[] {
  try {
    const data = JSON.parse(readFileSync(config.files.config, 'utf-8'))
    if (Array.isArray(data.profiles)) return data.profiles
  } catch { /* use frozen default */ }
  return config.profiles
}

/** Resolve the container home directory for a session, checking profile overrides. */
function resolveHome(config: TinstarConfig, session: Session): string {
  if (session.profile) {
    const profiles = freshProfiles(config)
    const prof = profiles.find(p => p.image === session.profile)
    if (prof?.home) return prof.home
  }
  return config.container.home
}

// --- Command builders (exported for testing) ---

export function containerName(config: TinstarConfig, sessionName: string): string {
  return `${config.container.prefix}${sessionName}`
}

export function buildVolumeFlags(config: TinstarConfig, session: Session & { _stateDir?: string }): string[] {
  const flags: string[] = []
  const stateDir = session._stateDir

  const home = resolveHome(config, session)

  // Claude state persistence (mount only the projects subdir so the image's
  // settings.json and hook scripts in ~/.claude/ are not shadowed)
  if (stateDir) {
    flags.push('-v', `${stateDir}:${home}/.claude/projects`)
  }

  // Mount host credentials so Claude can authenticate
  const hostCredentials = join(process.env.HOME ?? '/home/ubuntu', '.claude', '.credentials.json')
  flags.push('-v', `${hostCredentials}:${home}/.claude/.credentials.json:ro`)

  const ws = session.workspace
  if (!ws?.path) return flags

  // Mount workspace at its real absolute path
  flags.push('-v', `${ws.path}:${ws.path}`)

  // For worktrees, also mount the parent repo's .git
  if (ws.worktree && ws.basePath) {
    flags.push('-v', `${ws.basePath}/.git:${ws.basePath}/.git`)
  }

  return flags
}

export function buildSecretEnvFlags(secrets: Record<string, string>): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(secrets)) {
    if (value) {
      flags.push('-e', `${key}=${value}`)
    }
  }
  return flags
}

export function buildDockerRunCommand(
  config: TinstarConfig,
  session: Session & { _stateDir?: string },
  opts: { port: number },
): string[] {
  const name = containerName(config, session.name)
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000

  const args = [
    'run', '-d',
    '--user', `${uid}:${gid}`,
    '--ipc=host',
    '--add-host=host.docker.internal:host-gateway',
    '--name', name,
    '-p', `127.0.0.1:${opts.port}:${config.ports.ttyd}`,
  ]

  // Mount start-ttyd.sh from config dir so it works with any image
  const home = resolveHome(config, session)
  const scriptPath = join(config.dirs.root, 'start-ttyd.sh')
  args.push('-v', `${scriptPath}:${home}/start-ttyd.sh:ro`)

  args.push(...buildVolumeFlags(config, session))

  if (session.workspace?.path) {
    args.push('--workdir', session.workspace.path)
  }

  const image = session.profile ?? config.container.defaultImage
  args.push(image, 'sleep', 'infinity')

  return args
}

export function buildExecCommand(
  config: TinstarConfig,
  session: Session,
  secrets: Record<string, string>,
  opts: { sessionId?: string | null; resume?: boolean; dashboardUrl: string } = { dashboardUrl: '' },
): string[] {
  const name = containerName(config, session.name)

  const args = ['exec', '-d']

  args.push(...buildSecretEnvFlags(secrets))

  args.push('-e', `TINSTAR_SESSION_NAME=${session.name}`)
  // Inside the container, localhost refers to the container itself — rewrite to host.docker.internal
  const dockerDashboardUrl = opts.dashboardUrl.replace('localhost', 'host.docker.internal')
  args.push('-e', `TINSTAR_DASHBOARD_URL=${dockerDashboardUrl}`)
  // Compatibility aliases for images that use RF_* env vars in their hooks
  args.push('-e', `RF_SESSION_NAME=${session.name}`)
  args.push('-e', `RF_DASHBOARD_URL=${dockerDashboardUrl}`)

  // Enable Claude Code's native OTLP telemetry (claude_code_* metrics)
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://host.docker.internal:4318'
  args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${otelEndpoint.replace('localhost', 'host.docker.internal')}`)

  if (session.skipPermissions) {
    args.push('-e', 'SKIP_PERMISSIONS=1')
  }

  if (opts.resume && opts.sessionId) {
    args.push('-e', `RESUME_SESSION_ID=${opts.sessionId}`)
  } else if (opts.sessionId) {
    args.push('-e', `SESSION_ID=${opts.sessionId}`)
  }
  if (session.workspace?.path) {
    args.push('-e', `WORKSPACE_DIR=${session.workspace.path}`)
  }

  const home = resolveHome(config, session)
  args.push(name, `${home}/start-ttyd.sh`)
  return args
}

export function buildOneShotRunCommand(
  config: TinstarConfig,
  session: Session & { _stateDir?: string },
  opts: { prompt: string; secretEnvFlags?: string[] },
): string[] {
  const name = containerName(config, session.name)
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  const image = session.profile ?? config.container.defaultImage

  const args = [
    'run', '-d', '--rm',
    '--user', `${uid}:${gid}`,
    '--ipc=host',
    '--add-host=host.docker.internal:host-gateway',
    '--name', name,
  ]

  const ws = session.workspace
  if (ws?.path) {
    args.push('-v', `${ws.path}:${ws.path}`)
    if (ws.worktree && ws.basePath) {
      args.push('-v', `${ws.basePath}/.git:${ws.basePath}/.git`)
    }
    args.push('--workdir', ws.path)
  }

  if (opts.secretEnvFlags) {
    args.push(...opts.secretEnvFlags)
  }

  args.push('-e', `TINSTAR_SESSION_NAME=${session.name}`)

  // Enable Claude Code's native OTLP telemetry
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://host.docker.internal:4318'
  args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${otelEndpoint.replace('localhost', 'host.docker.internal')}`)

  const claudeArgs = ['claude']
  if (session.skipPermissions) {
    claudeArgs.push('--dangerously-skip-permissions')
  }
  claudeArgs.push('-p', opts.prompt)
  args.push(image, ...claudeArgs)

  return args
}

// --- Docker operations ---

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { encoding: 'utf-8' })
  return (stdout as string).trim()
}

export async function createContainer(
  config: TinstarConfig,
  opts: {
    session: Session & { _stateDir?: string }
    secrets: Record<string, string>
    port: number
    dashboardUrl: string
  },
): Promise<void> {
  const runArgs = buildDockerRunCommand(config, opts.session, { port: opts.port })
  await docker(runArgs)

  const execArgs = buildExecCommand(config, opts.session, opts.secrets, {
    sessionId: opts.session.conversation?.id,
    dashboardUrl: opts.dashboardUrl,
  })
  await docker(execArgs)
}

export async function createOneShotContainer(
  config: TinstarConfig,
  opts: {
    session: Session & { _stateDir?: string }
    secrets: Record<string, string>
    prompt: string
    onComplete?: (exitCode: number) => void
  },
): Promise<void> {
  const secretEnvFlags = buildSecretEnvFlags(opts.secrets)
  const runArgs = buildOneShotRunCommand(config, opts.session, { prompt: opts.prompt, secretEnvFlags })
  await docker(runArgs)

  // Watch container exit in background
  const name = containerName(config, opts.session.name)
  const watcher: ChildProcess = spawn('docker', ['wait', name], { stdio: 'ignore' })
  watcher.on('close', (code) => {
    if (opts.onComplete) opts.onComplete(code ?? 0)
  })
}

export async function startContainer(
  config: TinstarConfig,
  opts: {
    session: Session & { _stateDir?: string }
    secrets: Record<string, string>
    port: number
    dashboardUrl: string
  },
): Promise<void> {
  const name = containerName(config, opts.session.name)
  const state = await getContainerState(config, opts.session.name)

  if (state === 'missing') {
    const runArgs = buildDockerRunCommand(config, opts.session, { port: opts.port })
    await docker(runArgs)
  } else {
    await docker(['start', name])
  }

  const execArgs = buildExecCommand(config, opts.session, opts.secrets, {
    sessionId: opts.session.conversation?.id,
    resume: true,
    dashboardUrl: opts.dashboardUrl,
  })
  await docker(execArgs)
}

export async function stopContainer(config: TinstarConfig, session: Session): Promise<void> {
  const name = containerName(config, session.name)
  await docker(['stop', '-t', '5', name])
}

export async function deleteContainer(config: TinstarConfig, session: Session): Promise<void> {
  const name = containerName(config, session.name)
  try {
    await docker(['rm', '-f', name])
  } catch {
    // Already gone
  }
}

export async function getContainerState(config: TinstarConfig, sessionName: string): Promise<string> {
  const name = containerName(config, sessionName)
  try {
    return await docker(['inspect', '-f', '{{.State.Status}}', name])
  } catch {
    return 'missing'
  }
}

export async function sendPrompt(config: TinstarConfig, sessionName: string, prompt: string): Promise<void> {
  const name = containerName(config, sessionName)
  await docker(['exec', name, 'tmux', 'send-keys', '-t', 'main', prompt, ''])
  await new Promise(r => setTimeout(r, 300))
  await docker(['exec', name, 'tmux', 'send-keys', '-t', 'main', '', 'Enter'])
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
