import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type {
  CapabilitySupport,
  ProviderIdentity,
  ProviderSource,
} from '../../domain/provider-capabilities'
import type { RecapEntry } from '../../types'
import type { CliTemplate } from '../sessions/config'
import type { Session } from '../sessions/session'
import {
  findTranscriptByConvId,
  getProjectDir,
  getTranscriptPath,
  parseNewEntriesAt,
  readSessionStatusDetailAt,
  resetOffset,
} from '../sessions/transcript-parser'
import {
  CodexRolloutObservationSource,
  discoverTranscript as discoverCodexTranscript,
  parseCodexRecapEntries,
  readCodexStatus,
  resetCodexOffset,
  codexHomeDir,
} from '../sessions/codex-transcript'
import {
  defineProviderDeliveryAdapter,
  type ProviderDeliveryAdapter,
} from './contract'
import { codexMcpLaunchFlags } from './codex-mcp'
import type { ProviderTranscriptObservationEvent } from './observation-ingestor'
import type { ProviderAdapter as ObservationProviderAdapter } from './contract'

export interface ProviderTranscriptStatus {
  state: 'running' | 'idle'
  toolPending?: boolean
}

export interface ProviderTranscriptDiscovery {
  session: Session
  tmuxName: string
  /**
   * The managed terminal's actual launch directory. This stays separate from
   * the optional workspace record: standalone sessions have no workspace but
   * Codex still records its terminal cwd in the rollout metadata.
   */
  workingDirectory?: string | null
  captureScreen?: (tmuxName: string, scrollback?: number) => Promise<string>
}

export interface ProviderTranscriptObservations {
  /** Stable native source identity surfaced on provider-neutral snapshots. */
  source: ProviderSource
  /** Stable configured account identity; single-account providers use `default`. */
  accountRef: string
  read(
    sessionName: string,
    transcriptPath: string,
  ): ProviderTranscriptObservationEvent[]
}

/**
 * Provider-owned transcript behavior consumed by the shared managed-session
 * watcher. New providers implement this interface instead of adding their ID
 * to the watcher.
 */
export interface ProviderTranscriptAdapter {
  discover(request: ProviderTranscriptDiscovery): Promise<string | null>
  readStatus(transcriptPath: string): ProviderTranscriptStatus | null
  parseRecapEntries(sessionName: string, transcriptPath: string): RecapEntry[]
  resetOffset(sessionName: string): void
  /** Optional normalized native observations, polled independently of status. */
  observations?: ProviderTranscriptObservations
  /** Number of identical idle observations required before running -> idle. */
  idleDebouncePolls?: number
  /** Parse offset-based recap entries on unchanged idle observations too. */
  parseRecapWhileIdle?: boolean
  /**
   * Providers whose conversation identity is a file name in a shared project
   * directory expose that directory here. The watcher can then run its generic
   * collision-repair algorithm; providers without that model omit the hook.
   */
  conversationProjectDir?: (workdir: string) => string
}

interface ProviderNatsLaunchCapability {
  /** Provider-defined diagnostic label; shared lifecycle code never branches on it. */
  transport: string
  command: {
    /** Provider-owned shell fragments injected before the prompt separator. */
    launchFlags: (mcpConfigPath?: string | null) => readonly string[]
    /** The provider reads descriptor env values from its inherited environment. */
    forwardServerEnvironment: boolean
    disabledPattern: RegExp
    autoAcceptWarning: boolean
  }
}

export interface ProviderTelemetryLaunchContext {
  sessionName: string
  logsEndpoint: string
  metricsEndpoint: string
}

interface ProviderTelemetryLaunchCapability {
  /** Provider-defined diagnostic label; shared lifecycle code never branches on it. */
  transport: string
  /** Environment-based exporters such as Claude Code. */
  environment?: (context: {
    sessionName: string
    endpoint: string
  }) => Record<string, string>
  /** Command-based exporters such as Codex's one-off TOML overrides. */
  launchFlags?: (context: ProviderTelemetryLaunchContext) => readonly string[]
}

export interface ProviderManagedInstructionsContext {
  sessionDir: string
  version: string
  content: string
}

export interface PreparedManagedInstructions {
  version: string
  mechanism: string
  launchFlags: readonly string[]
  artifactPath?: string
}

interface ProviderManagedInstructionsCapability {
  /** Stable diagnostic label persisted with the session launch receipt. */
  mechanism: string
  /** Optional environment/CLI compatibility check run before provisioning. */
  validate?: () => void
  /** May create provider-private artifacts, but never writes into the workspace. */
  prepare: (context: ProviderManagedInstructionsContext) => PreparedManagedInstructions
}

export interface TerminalProviderCapabilities {
  nats: CapabilitySupport<{
    transport: ProviderNatsLaunchCapability['transport']
    command: ProviderNatsLaunchCapability['command']
  }>
  telemetry: CapabilitySupport<{
    transport: ProviderTelemetryLaunchCapability['transport']
    environment?: ProviderTelemetryLaunchCapability['environment']
    launchFlags?: ProviderTelemetryLaunchCapability['launchFlags']
  }>
  managedInstructions: CapabilitySupport<ProviderManagedInstructionsCapability>
}

export type TerminalProviderCapability = keyof TerminalProviderCapabilities

/**
 * The lifecycle slice every managed provider supplies. It intentionally shares
 * the provider/sessionLifecycle fields with ProviderAdapter from contract.ts:
 * a full observation/delivery adapter is structurally compatible with this
 * registry when it adds terminal behavior, while lifecycle-only providers can
 * land before their observation migrations.
 */
export interface TerminalProviderAdapter {
  provider: ProviderIdentity
  sessionLifecycle: 'terminal'
  terminal: {
    capabilities: TerminalProviderCapabilities
    /** Preserve Claude's historical implicit telemetry; other providers opt in. */
    defaultTelemetry: boolean
    transcript: ProviderTranscriptAdapter | null
    /** Provider-owned environment reconciled on every managed agent launch. */
    managedEnvironment?: {
      names: readonly string[]
      values: () => Record<string, string>
    }
  }
  /** Provider-owned final mile; configured by the host when it needs runtime dependencies. */
  delivery?: ProviderDeliveryAdapter | null
}

export class ProviderAdapterResolutionError extends Error {
  readonly name = 'ProviderAdapterResolutionError'
}

export class ProviderCapabilityError extends Error {
  readonly name = 'ProviderCapabilityError'

  constructor(
    readonly providerId: string,
    readonly capability: TerminalProviderCapability,
    readonly reason: string,
  ) {
    super(
      `Provider "${providerId}" does not support terminal capability `
      + `"${capability}": ${reason}`,
    )
  }
}

/**
 * Open provider registry. Provider IDs are data, never a shared union: a third
 * provider registers one adapter and templates can reference it immediately.
 */
export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, TerminalProviderAdapter>()
  private readonly deliveries = new Map<string, ProviderDeliveryAdapter>()
  private readonly observationAdapters = new Map<string, ObservationProviderAdapter>()

  constructor(adapters: readonly TerminalProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register<T extends TerminalProviderAdapter>(adapter: T): T {
    const id = adapter.provider.id.trim()
    if (!id) throw new ProviderAdapterResolutionError('Provider adapter id must not be empty')
    if (id !== adapter.provider.id) {
      throw new ProviderAdapterResolutionError(
        `Provider adapter id "${adapter.provider.id}" must not have surrounding whitespace`,
      )
    }
    if (this.adapters.has(id)) {
      throw new ProviderAdapterResolutionError(`Provider adapter "${id}" is already registered`)
    }
    this.adapters.set(id, adapter)
    if (adapter.delivery) {
      this.deliveries.set(id, defineProviderDeliveryAdapter(id, adapter.delivery))
    }
    return adapter
  }

  registerDelivery(providerId: string, delivery: ProviderDeliveryAdapter): void {
    this.require(providerId)
    if (this.deliveries.has(providerId)) {
      throw new ProviderAdapterResolutionError(
        `Provider adapter "${providerId}" already has delivery configured`,
      )
    }
    this.deliveries.set(providerId, defineProviderDeliveryAdapter(providerId, delivery))
  }

  deliveryFor(providerId: string): ProviderDeliveryAdapter | null {
    this.require(providerId)
    return this.deliveries.get(providerId) ?? null
  }

  get(providerId: string): TerminalProviderAdapter | undefined {
    return this.adapters.get(providerId)
  }

  registerObservations<T extends ObservationProviderAdapter>(adapter: T): T {
    const provider = this.require(adapter.provider.id)
    if (provider.provider.label !== adapter.provider.label) {
      throw new ProviderAdapterResolutionError(
        `Provider observation adapter "${adapter.provider.id}" label `
        + `"${adapter.provider.label}" does not match lifecycle label `
        + `"${provider.provider.label}"`,
      )
    }
    if (this.observationAdapters.has(adapter.provider.id)) {
      throw new ProviderAdapterResolutionError(
        `Provider observation adapter "${adapter.provider.id}" is already registered`,
      )
    }
    this.observationAdapters.set(adapter.provider.id, adapter)
    return adapter
  }

  getObservations(providerId: string): ObservationProviderAdapter | undefined {
    return this.observationAdapters.get(providerId)
  }

  requireObservations(providerId: string): ObservationProviderAdapter {
    this.require(providerId)
    const adapter = this.observationAdapters.get(providerId)
    if (!adapter) {
      throw new ProviderAdapterResolutionError(
        `Provider observation adapter "${providerId}" is not registered`,
      )
    }
    return adapter
  }

  require(providerId: string): TerminalProviderAdapter {
    const adapter = this.adapters.get(providerId)
    if (!adapter) {
      throw new ProviderAdapterResolutionError(
        `Provider adapter "${providerId}" is not registered`,
      )
    }
    return adapter
  }

  /**
   * Adapter-less templates predate provider metadata and have always launched
   * Claude. Keep that compatibility rule in one place.
   */
  resolveTemplate(template: CliTemplate | null | undefined): TerminalProviderAdapter {
    return this.require(template?.adapter ?? 'claude')
  }

  /**
   * The provider ID is persisted on new sessions. Legacy records may be null,
   * in which case their template (or the historical Claude default) resolves it.
   */
  resolveSession(
    session: Pick<Session, 'adapter'>,
    template?: CliTemplate | null,
  ): TerminalProviderAdapter {
    const templateProvider = template
      ? this.resolveTemplate(template).provider.id
      : null
    if (session.adapter && templateProvider && session.adapter !== templateProvider) {
      throw new ProviderAdapterResolutionError(
        `Session provider "${session.adapter}" does not match template `
        + `provider "${templateProvider}"`,
      )
    }
    return this.require(session.adapter ?? templateProvider ?? 'claude')
  }
}

export function requireProviderCapability<K extends TerminalProviderCapability>(
  adapter: TerminalProviderAdapter,
  capability: K,
): Extract<TerminalProviderCapabilities[K], { state: 'supported' }>['detail'] {
  const support = adapter.terminal.capabilities[capability]
  if (support.state === 'unsupported') {
    throw new ProviderCapabilityError(
      adapter.provider.id,
      capability,
      support.reason,
    )
  }
  return support.detail as Extract<
    TerminalProviderCapabilities[K],
    { state: 'supported' }
  >['detail']
}

export function providerTelemetryEnabled(
  adapter: TerminalProviderAdapter,
  template: CliTemplate | null | undefined,
): boolean {
  const requested = template?.telemetry ?? adapter.terminal.defaultTelemetry
  if (!requested) return false
  requireProviderCapability(adapter, 'telemetry')
  return true
}

const claudeTranscript: ProviderTranscriptAdapter = {
  async discover({ session }) {
    const convId = session.conversation?.id
    if (!convId) return null
    const workdir = session.workspace?.path
    return workdir
      ? getTranscriptPath(workdir, convId)
      : findTranscriptByConvId(convId)
  },
  readStatus: readSessionStatusDetailAt,
  parseRecapEntries: parseNewEntriesAt,
  resetOffset,
  idleDebouncePolls: 2,
  conversationProjectDir: getProjectDir,
}

const codexRolloutObservations = new CodexRolloutObservationSource()

const codexTranscript: ProviderTranscriptAdapter = {
  async discover({ session, tmuxName, workingDirectory, captureScreen }) {
    const workdir = session.workspace?.path ?? workingDirectory
    if (!workdir) return null
    return discoverCodexTranscript(
      session.name,
      workdir,
      session.created,
      tmuxName,
      captureScreen,
    )
  },
  readStatus(transcriptPath) {
    const state = readCodexStatus(transcriptPath)
    return state ? { state } : null
  },
  parseRecapEntries: parseCodexRecapEntries,
  observations: {
    source: { id: 'rollout', label: 'Codex rollout events' },
    accountRef: 'default',
    read(sessionName, transcriptPath) {
      return codexRolloutObservations.read(sessionName, transcriptPath)
    },
  },
  resetOffset(sessionName) {
    resetCodexOffset(sessionName)
    codexRolloutObservations.reset(sessionName)
  },
  idleDebouncePolls: 1,
  parseRecapWhileIdle: true,
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const unsupportedNats = (provider: string): TerminalProviderCapabilities['nats'] => ({
  state: 'unsupported',
  reason: `${provider} has no managed NATS launch transport`,
})

const unsupportedTelemetry = (
  provider: string,
): TerminalProviderCapabilities['telemetry'] => ({
  state: 'unsupported',
  reason: `${provider} has no managed OTLP telemetry transport`,
})

const unsupportedManagedInstructions = (
  provider: string,
): TerminalProviderCapabilities['managedInstructions'] => ({
  state: 'unsupported',
  reason: `${provider} has no managed standing-instruction mechanism`,
})

function writePrivateFile(path: string, content: string): void {
  let current: string | null = null
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`managed-instruction artifact is not a regular file: ${path}`)
    }
    current = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (current === content ? 0 : constants.O_TRUNC)
  const fd = openSync(path, flags, 0o600)
  try {
    if (current !== content) writeFileSync(fd, content)
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}

function ensurePrivateDirectory(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`managed-instruction artifact is not a directory: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(path, { mode: 0o700 })
  }
  chmodSync(path, 0o700)
}

function prepareCursorManagedInstructions(
  context: ProviderManagedInstructionsContext,
): PreparedManagedInstructions {
  ensurePrivateDirectory(context.sessionDir)
  const pluginDir = join(context.sessionDir, 'managed-instructions', 'cursor-slate-first')
  ensurePrivateDirectory(join(context.sessionDir, 'managed-instructions'))
  const manifestDir = join(pluginDir, '.cursor-plugin')
  const rulesDir = join(pluginDir, 'rules')
  ensurePrivateDirectory(pluginDir)
  ensurePrivateDirectory(manifestDir)
  ensurePrivateDirectory(rulesDir)

  writePrivateFile(join(manifestDir, 'plugin.json'), `${JSON.stringify({
    name: 'tinstar-slate-first',
    displayName: 'Tinstar Slate-first collaboration',
    version: '1.0.0',
    description: 'Standing instructions for Tinstar Slate-first managed sessions.',
    author: { name: 'Tinstar' },
  }, null, 2)}\n`)
  writePrivateFile(join(rulesDir, 'slate-first.mdc'), `---
description: Tinstar Slate-first collaboration contract (${context.version})
alwaysApply: true
---

${context.content}
`)

  return {
    version: context.version,
    mechanism: 'cursor-local-plugin-rule',
    launchFlags: [`--plugin-dir ${shellQuote(pluginDir)}`],
    artifactPath: pluginDir,
  }
}

let cursorPluginSupportValidated = false

function validateCursorPluginSupport(): void {
  if (cursorPluginSupportValidated) return
  let help = ''
  try {
    help = execFileSync('agent', ['--help'], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`Cursor Agent CLI is unavailable: ${(err as Error).message}`)
  }
  if (!help.includes('--plugin-dir')) {
    throw new Error('Cursor Agent CLI does not support the required --plugin-dir option')
  }
  cursorPluginSupportValidated = true
}

export function validateProviderManagedInstructions(adapter: TerminalProviderAdapter): void {
  const capability = requireProviderCapability(adapter, 'managedInstructions')
  capability.validate?.()
}

export function prepareProviderManagedInstructions(
  adapter: TerminalProviderAdapter,
  context: ProviderManagedInstructionsContext,
): PreparedManagedInstructions {
  return requireProviderCapability(adapter, 'managedInstructions').prepare(context)
}

export const CLAUDE_PROVIDER: TerminalProviderAdapter = {
  provider: { id: 'claude', label: 'Claude Code' },
  sessionLifecycle: 'terminal',
  terminal: {
    capabilities: {
      nats: {
        state: 'supported',
        detail: {
          transport: 'claude-development-channel',
          command: {
            launchFlags: (mcpConfigPath) => [
              '--dangerously-load-development-channels server:nats',
              ...(mcpConfigPath ? [`--mcp-config ${shellQuote(mcpConfigPath)}`] : []),
            ],
            forwardServerEnvironment: false,
            disabledPattern: /\s*--dangerously-load-development-channels\s+server:nats/g,
            autoAcceptWarning: true,
          },
        },
      },
      telemetry: {
        state: 'supported',
        detail: {
          transport: 'otlp-environment',
          environment: ({ sessionName, endpoint }) => ({
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_METRICS_EXPORTER: 'otlp',
            OTEL_LOGS_EXPORTER: 'otlp',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
            OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
            OTEL_METRIC_EXPORT_INTERVAL: '10000',
            OTEL_RESOURCE_ATTRIBUTES: `tinstar.session=${sessionName}`,
          }),
        },
      },
      managedInstructions: {
        state: 'supported',
        detail: {
          mechanism: 'claude-append-system-prompt',
          prepare: context => ({
            version: context.version,
            mechanism: 'claude-append-system-prompt',
            launchFlags: [
              `--append-system-prompt ${shellQuote(context.content)}`,
            ],
          }),
        },
      },
    },
    defaultTelemetry: true,
    transcript: claudeTranscript,
  },
}

export const CODEX_PROVIDER: TerminalProviderAdapter = {
  provider: { id: 'codex', label: 'Codex' },
  sessionLifecycle: 'terminal',
  terminal: {
    capabilities: {
      nats: {
        state: 'supported',
        detail: {
          transport: 'codex-stdio-mcp',
          command: {
            launchFlags: (mcpConfigPath) => (
              mcpConfigPath ? codexMcpLaunchFlags(mcpConfigPath) : []
            ),
            forwardServerEnvironment: true,
            // Managed flags are always generated from the current descriptor;
            // there is no provider flag that belongs baked into templates.
            disabledPattern: /\b\B/g,
            autoAcceptWarning: false,
          },
        },
      },
      telemetry: {
        state: 'supported',
        detail: {
          transport: 'codex-otlp-http',
          launchFlags: ({ logsEndpoint, metricsEndpoint }) => [
            `--config ${shellQuote('otel.environment="tinstar"')}`,
            `--config ${shellQuote(`otel.exporter={ otlp-http = { endpoint = "${logsEndpoint}", protocol = "json" } }`)}`,
            `--config ${shellQuote(`otel.metrics_exporter={ otlp-http = { endpoint = "${metricsEndpoint}", protocol = "json" } }`)}`,
            `--config ${shellQuote('otel.trace_exporter="none"')}`,
            `--config ${shellQuote('otel.log_user_prompt=false')}`,
          ],
        },
      },
      managedInstructions: {
        state: 'supported',
        detail: {
          mechanism: 'codex-developer-instructions',
          prepare: context => ({
            version: context.version,
            mechanism: 'codex-developer-instructions',
            launchFlags: [
              `--config ${shellQuote(`developer_instructions=${JSON.stringify(context.content)}`)}`,
            ],
          }),
        },
      },
    },
    defaultTelemetry: true,
    transcript: codexTranscript,
    managedEnvironment: {
      names: ['CODEX_HOME'],
      values: (): Record<string, string> => {
        const configured = process.env.CODEX_HOME?.trim()
        if (!configured) return {}
        return { CODEX_HOME: codexHomeDir() }
      },
    },
  },
}

export const CURSOR_PROVIDER: TerminalProviderAdapter = {
  provider: { id: 'cursor', label: 'Cursor Agent' },
  sessionLifecycle: 'terminal',
  terminal: {
    capabilities: {
      nats: unsupportedNats('Cursor Agent'),
      telemetry: unsupportedTelemetry('Cursor Agent'),
      managedInstructions: {
        state: 'supported',
        detail: {
          mechanism: 'cursor-local-plugin-rule',
          validate: validateCursorPluginSupport,
          prepare: prepareCursorManagedInstructions,
        },
      },
    },
    defaultTelemetry: false,
    transcript: null,
  },
}

export const GENERIC_PROVIDER: TerminalProviderAdapter = {
  provider: { id: 'generic', label: 'Generic terminal CLI' },
  sessionLifecycle: 'terminal',
  terminal: {
    capabilities: {
      nats: unsupportedNats('Generic terminal CLI'),
      telemetry: unsupportedTelemetry('Generic terminal CLI'),
      managedInstructions: unsupportedManagedInstructions('Generic terminal CLI'),
    },
    defaultTelemetry: false,
    transcript: null,
  },
}

export function createDefaultProviderRegistry(
  additional: readonly TerminalProviderAdapter[] = [],
): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry([
    CLAUDE_PROVIDER,
    CODEX_PROVIDER,
    CURSOR_PROVIDER,
    GENERIC_PROVIDER,
    ...additional,
  ])
}

export const defaultProviderRegistry = createDefaultProviderRegistry()
