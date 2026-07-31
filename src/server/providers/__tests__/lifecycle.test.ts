import { describe, expect, it } from 'vitest'

import type { CliTemplate } from '../../sessions/config'
import { buildAgentCommand } from '../../sessions/backends/tmux'
import {
  ProviderAdapterRegistry,
  ProviderCapabilityError,
  createDefaultProviderRegistry,
  providerTelemetryEnabled,
  requireProviderCapability,
  type TerminalProviderAdapter,
} from '../lifecycle'

function template(
  name: string,
  adapter: string | undefined,
  startCmd: string,
  resumeCmd: string,
): CliTemplate {
  return { id: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), name, adapter, startCmd, resumeCmd }
}

function capabilityLightProvider(id: string): TerminalProviderAdapter {
  return {
    provider: { id, label: `${id} CLI` },
    sessionLifecycle: 'terminal',
    terminal: {
      capabilities: {
        nats: { state: 'unsupported', reason: `${id} has no NATS transport` },
        telemetry: { state: 'unsupported', reason: `${id} has no telemetry transport` },
      },
      defaultTelemetry: false,
      transcript: null,
    },
  }
}

describe('provider lifecycle registry', () => {
  it('keeps legacy and adapter-less custom templates on the Claude provider', () => {
    const registry = createDefaultProviderRegistry()
    expect(registry.resolveTemplate(null).provider.id).toBe('claude')
    expect(registry.resolveTemplate(template(
      'My old template',
      undefined,
      'claude -- {prompt}',
      'claude --resume {sessionId}',
    )).provider.id).toBe('claude')
  })

  it('keeps explicit generic templates capability-light and terminal-first', () => {
    const registry = createDefaultProviderRegistry()
    const provider = registry.resolveTemplate(template(
      'My terminal tool',
      'generic',
      'mytool -- {prompt}',
      'mytool resume',
    ))

    expect(provider.provider.id).toBe('generic')
    expect(provider.sessionLifecycle).toBe('terminal')
    expect(provider.terminal.transcript).toBeNull()
  })

  it('registers a fake third provider without changing shared provider IDs', () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(capabilityLightProvider('forge'))

    expect(registry.require('forge').provider.label).toBe('forge CLI')
    expect(registry.resolveTemplate(template(
      'Forge',
      'forge',
      'forge run -- {prompt}',
      'forge resume',
    )).provider.id).toBe('forge')
  })

  it('rejects unknown configured providers instead of silently launching Claude', () => {
    const registry = createDefaultProviderRegistry()
    expect(() => registry.resolveTemplate(template(
      'Typo',
      'claud',
      'claude -- {prompt}',
      'claude --resume {sessionId}',
    ))).toThrow('Provider adapter "claud" is not registered')
  })

  it('rejects a mutable template that drifts from the persisted session provider', () => {
    const registry = createDefaultProviderRegistry()
    const changedTemplate = template(
      'Changed after launch',
      'claude',
      'claude -- {prompt}',
      'claude --resume {sessionId}',
    )

    expect(() => registry.resolveSession(
      { adapter: 'codex' },
      changedTemplate,
    )).toThrow(
      'Session provider "codex" does not match template provider "claude"',
    )
  })

  it('rejects provider IDs whose persisted identity would not match the registry key', () => {
    const registry = new ProviderAdapterRegistry()
    expect(() => registry.register(capabilityLightProvider(' forge '))).toThrow(
      'Provider adapter id " forge " must not have surrounding whitespace',
    )
  })

  it('fails clearly when a provider is asked for an unsupported launch capability', () => {
    const provider = capabilityLightProvider('observer')

    expect(() => requireProviderCapability(provider, 'nats')).toThrow(ProviderCapabilityError)
    expect(() => requireProviderCapability(provider, 'nats'))
      .toThrow('Provider "observer" does not support terminal capability "nats": observer has no NATS transport')
    expect(() => providerTelemetryEnabled(provider, {
      id: 'observer-with-telemetry',
      name: 'Observer with telemetry',
      adapter: 'observer',
      telemetry: true,
      startCmd: 'observer',
      resumeCmd: 'observer resume',
    })).toThrow(
      'Provider "observer" does not support terminal capability "telemetry": '
      + 'observer has no telemetry transport',
    )
  })

  it('preserves the current Claude and Codex terminal commands', () => {
    const registry = createDefaultProviderRegistry()
    const claudeTemplate = template(
      'Claude',
      'claude',
      'claude --dangerously-skip-permissions --session-id {sessionId} -- {prompt}',
      'claude --dangerously-skip-permissions --resume {sessionId}',
    )
    const codexTemplate = template(
      'Codex',
      'codex',
      'codex --sandbox workspace-write -- {prompt}',
      'codex resume --last --sandbox workspace-write',
    )

    expect(buildAgentCommand({
      provider: registry.resolveTemplate(claudeTemplate),
      template: claudeTemplate,
      sessionId: 'sid',
      initialPrompt: 'do it',
    })).toBe("claude --dangerously-skip-permissions --session-id sid -- 'do it'")
    expect(buildAgentCommand({
      provider: registry.resolveTemplate(codexTemplate),
      template: codexTemplate,
      sessionId: 'ignored',
      initialPrompt: 'do it',
    })).toBe("codex --sandbox workspace-write -- 'do it'")
    expect(buildAgentCommand({
      provider: registry.resolveTemplate(codexTemplate),
      template: codexTemplate,
      sessionId: 'ignored',
      resume: true,
    })).toBe('codex resume --last --sandbox workspace-write')
  })
})
