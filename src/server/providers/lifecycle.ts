import type { CapabilitySupport, ProviderIdentity } from '../../domain/provider-capabilities'
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
  discoverTranscript as discoverCodexTranscript,
  parseCodexRecapEntries,
  readCodexStatus,
  resetCodexOffset,
} from '../sessions/codex-transcript'
import {
  defineProviderDeliveryAdapter,
  type ProviderDeliveryAdapter,
} from './contract'
import { codexMcpLaunchFlags } from './codex-mcp'

export interface ProviderTranscriptStatus {
  state: 'running' | 'idle'
  toolPending?: boolean
}

export interface ProviderTranscriptDiscovery {
  session: Session
  tmuxName: string
  captureScreen?: (tmuxName: string, scrollback?: number) => Promise<string>
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

interface ProviderTelemetryLaunchCapability {
  /** Provider-defined diagnostic label; shared lifecycle code never branches on it. */
  transport: string
  environment(context: {
    sessionName: string
    endpoint: string
  }): Record<string, string>
}

export interface TerminalProviderCapabilities {
  nats: CapabilitySupport<{
    transport: ProviderNatsLaunchCapability['transport']
    command: ProviderNatsLaunchCapability['command']
  }>
  telemetry: CapabilitySupport<{
    transport: ProviderTelemetryLaunchCapability['transport']
    environment: ProviderTelemetryLaunchCapability['environment']
  }>
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

const codexTranscript: ProviderTranscriptAdapter = {
  async discover({ session, tmuxName, captureScreen }) {
    const workdir = session.workspace?.path
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
  resetOffset: resetCodexOffset,
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
      telemetry: unsupportedTelemetry('Codex'),
    },
    defaultTelemetry: false,
    transcript: codexTranscript,
  },
}

export const GENERIC_PROVIDER: TerminalProviderAdapter = {
  provider: { id: 'generic', label: 'Generic terminal CLI' },
  sessionLifecycle: 'terminal',
  terminal: {
    capabilities: {
      nats: unsupportedNats('Generic terminal CLI'),
      telemetry: unsupportedTelemetry('Generic terminal CLI'),
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
    GENERIC_PROVIDER,
    ...additional,
  ])
}

export const defaultProviderRegistry = createDefaultProviderRegistry()
