import { describe, it, expect } from 'vitest'

import { buildAgentCommand, providerTelemetryEnvironmentCommands } from '../tmux'
import type { AgentDef } from '../tmux'
import type { CliTemplate } from '../../config'
import {
  CLAUDE_PROVIDER,
  GENERIC_PROVIDER,
  ProviderCapabilityError,
  type TerminalProviderAdapter,
} from '../../../providers/lifecycle'

const AGENT: AgentDef = { name: 'marshal', description: 'the marshal', prompt: 'BE THE MARSHAL' }

function tmpl(startCmd: string, resumeCmd: string): CliTemplate {
  return { id: 'marshal', name: 'marshal', startCmd, resumeCmd }
}

describe('buildAgentCommand persona handling', () => {
  it('skips the appendSystemPrompt fallback when the start command interpolates the persona', () => {
    const cmd = buildAgentCommand({
      template: tmpl('claude --append-system-prompt {agentPrompt} --session-id {sessionId} -- {prompt}', 'claude --resume {sessionId}'),
      sessionId: 'sid', resume: false, initialPrompt: 'hi', agent: AGENT, appendSystemPrompt: 'BE THE MARSHAL',
    })
    // Persona interpolated exactly once; no duplicate --append-system-prompt appended.
    expect(cmd.match(/--append-system-prompt/g)?.length).toBe(1)
    expect(cmd).toContain('BE THE MARSHAL')
  })

  it('falls back to appendSystemPrompt on resume when only the start command interpolates the persona', () => {
    const cmd = buildAgentCommand({
      template: tmpl('claude --append-system-prompt {agentPrompt} --session-id {sessionId} -- {prompt}', 'claude --resume {sessionId}'),
      sessionId: 'sid', resume: true, agent: AGENT, appendSystemPrompt: 'BE THE MARSHAL',
    })
    // resumeCmd has no placeholder, so the fallback must carry the persona.
    expect(cmd.match(/--append-system-prompt/g)?.length).toBe(1)
    expect(cmd).toContain('BE THE MARSHAL')
  })

  it('falls back to appendSystemPrompt on create when only the resume command interpolates the persona', () => {
    const cmd = buildAgentCommand({
      template: tmpl('claude --session-id {sessionId} -- {prompt}', 'claude --append-system-prompt {agentPrompt} --resume {sessionId}'),
      sessionId: 'sid', resume: false, initialPrompt: 'hi', agent: AGENT, appendSystemPrompt: 'BE THE MARSHAL',
    })
    // startCmd has no placeholder, so the fallback must carry the persona.
    expect(cmd.match(/--append-system-prompt/g)?.length).toBe(1)
    expect(cmd).toContain('BE THE MARSHAL')
  })

  it('skips the appendSystemPrompt fallback when the resume command interpolates the persona', () => {
    const cmd = buildAgentCommand({
      template: tmpl('claude --session-id {sessionId} -- {prompt}', 'claude --append-system-prompt {agentPrompt} --resume {sessionId}'),
      sessionId: 'sid', resume: true, agent: AGENT, appendSystemPrompt: 'BE THE MARSHAL',
    })
    expect(cmd.match(/--append-system-prompt/g)?.length).toBe(1)
    expect(cmd).toContain('BE THE MARSHAL')
  })
})

describe('provider telemetry environment reconciliation', () => {
  it('removes every provider-owned variable when telemetry is disabled on restart', () => {
    const commands = providerTelemetryEnvironmentCommands(
      '=tinstar-worker',
      'worker',
      CLAUDE_PROVIDER,
      { ...tmpl('claude', 'claude'), telemetry: false },
      'http://otel:4318',
    )

    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every(command => command.includes('-r'))).toBe(true)
    expect(commands).toContainEqual([
      'set-environment',
      '-t',
      '=tinstar-worker',
      '-r',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
    ])
  })

  it('sets provider-owned variables when telemetry is enabled on restart', () => {
    const commands = providerTelemetryEnvironmentCommands(
      '=tinstar-worker',
      'worker',
      CLAUDE_PROVIDER,
      { ...tmpl('claude', 'claude'), telemetry: true },
      'http://otel:4318',
    )

    expect(commands.some(command => command.includes('-r'))).toBe(false)
    expect(commands).toContainEqual([
      'set-environment',
      '-t',
      '=tinstar-worker',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'http://otel:4318',
    ])
  })

  it('returns no commands when an unsupported provider uses its disabled default', () => {
    expect(providerTelemetryEnvironmentCommands(
      '=tinstar-worker',
      'worker',
      GENERIC_PROVIDER,
      tmpl('agent', 'agent resume'),
    )).toEqual([])
  })

  it('rejects an explicit telemetry opt-in for an unsupported provider', () => {
    expect(() => providerTelemetryEnvironmentCommands(
      '=tinstar-worker',
      'worker',
      GENERIC_PROVIDER,
      { ...tmpl('agent', 'agent resume'), telemetry: true },
    )).toThrow(ProviderCapabilityError)
  })
})

describe('buildAgentCommand NATS dev-channel coupling', () => {
  // The default multi-agent template bakes in the dev-channels flag; NATS is
  // only actually provisioned (a .mcp.json is written) for some sessions.
  const NATS_TMPL = tmpl(
    'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --session-id {sessionId} -- {prompt}',
    'claude --dangerously-skip-permissions --dangerously-load-development-channels server:nats --resume {sessionId}',
  )

  it('strips the dev-channels flag when NATS was not provisioned (blank project)', () => {
    const cmd = buildAgentCommand({
      template: NATS_TMPL, sessionId: 'sid', resume: false, initialPrompt: 'my prompt', nats: null,
    })
    expect(cmd).not.toContain('--dangerously-load-development-channels')
    expect(cmd).not.toContain('server:nats')
    expect(cmd).not.toContain('--mcp-config')
    // The prompt (and every other flag) survives intact.
    expect(cmd).toContain('-- ')
    expect(cmd).toContain('my prompt')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--session-id sid')
    // No double spaces left behind by the removal.
    expect(cmd).not.toMatch(/ {2,}/)
  })

  it('strips the dev-channels flag on resume when NATS was not provisioned', () => {
    const cmd = buildAgentCommand({
      template: NATS_TMPL, sessionId: 'sid', resume: true, nats: { enabled: false },
    })
    expect(cmd).not.toContain('server:nats')
    expect(cmd).not.toContain('--mcp-config')
    expect(cmd).toContain('--resume sid')
  })

  it('injects --mcp-config (before the -- separator) when NATS is provisioned', () => {
    const cmd = buildAgentCommand({
      template: NATS_TMPL, sessionId: 'sid', resume: false, initialPrompt: 'my prompt',
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })
    expect(cmd).toContain('--dangerously-load-development-channels server:nats')
    expect(cmd.match(/--dangerously-load-development-channels server:nats/g)).toHaveLength(1)
    expect(cmd).toContain("--mcp-config '/cfg/nats-mcp.json'")
    // --mcp-config stays an option, before the prompt separator.
    expect(cmd.indexOf('--mcp-config')).toBeLessThan(cmd.indexOf(' -- '))
    expect(cmd).toContain('my prompt')
    expect(cmd).not.toMatch(/ {2,}/)
  })

  it('injects --mcp-config on resume (no -- separator) when NATS is provisioned', () => {
    const cmd = buildAgentCommand({
      template: NATS_TMPL, sessionId: 'sid', resume: true,
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })
    expect(cmd).toContain('--dangerously-load-development-channels server:nats')
    expect(cmd.match(/--dangerously-load-development-channels server:nats/g)).toHaveLength(1)
    expect(cmd).toContain("--mcp-config '/cfg/nats-mcp.json'")
    expect(cmd).toContain('--resume sid')
  })

  it('keeps the dev-channels flag but emits no --mcp-config when the path is absent', () => {
    const cmd = buildAgentCommand({
      template: NATS_TMPL, sessionId: 'sid', resume: false, initialPrompt: 'my prompt', nats: { enabled: true },
    })
    expect(cmd).toContain('--dangerously-load-development-channels server:nats')
    expect(cmd).not.toContain('--mcp-config')
    expect(cmd).toContain('my prompt')
  })

  it.each([
    ['auto', 'claude --dangerously-skip-permissions --session-id {sessionId} -- {prompt}'],
    ['interactive', 'claude --session-id {sessionId} -- {prompt}'],
  ])('adds the enable flag to a Claude %s template that does not bake it in', (_name, startCmd) => {
    const cmd = buildAgentCommand({
      template: tmpl(startCmd, 'claude --resume {sessionId}'),
      sessionId: 'sid', resume: false, initialPrompt: 'my prompt',
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })

    expect(cmd.match(/--dangerously-load-development-channels server:nats/g)).toHaveLength(1)
    expect(cmd.indexOf('--dangerously-load-development-channels')).toBeLessThan(cmd.indexOf('--mcp-config'))
    expect(cmd.indexOf('--mcp-config')).toBeLessThan(cmd.indexOf(' -- '))
  })

  it('adds the enable and config flags to a resume command with no prompt separator', () => {
    const cmd = buildAgentCommand({
      template: tmpl('claude --session-id {sessionId} -- {prompt}', 'claude --resume {sessionId}'),
      sessionId: 'sid', resume: true,
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })

    expect(cmd).toBe(
      "claude --resume sid --dangerously-load-development-channels server:nats --mcp-config '/cfg/nats-mcp.json'",
    )
  })

  it('normalizes repeated pre-baked enable flags to one', () => {
    const cmd = buildAgentCommand({
      template: tmpl(
        'claude --dangerously-load-development-channels server:nats --session-id {sessionId} --dangerously-load-development-channels server:nats -- {prompt}',
        'claude --resume {sessionId}',
      ),
      sessionId: 'sid', resume: false, initialPrompt: 'my prompt', nats: { enabled: true },
    })

    expect(cmd.match(/--dangerously-load-development-channels server:nats/g)).toHaveLength(1)
    expect(cmd).toBe(
      "claude --session-id sid --dangerously-load-development-channels server:nats -- 'my prompt'",
    )
  })

  it('normalizes provider flags without rewriting an opaque user prompt', () => {
    const prompt = 'explain --dangerously-load-development-channels server:nats please'
    const cmd = buildAgentCommand({
      template: tmpl(
        'claude --dangerously-load-development-channels server:nats --session-id {sessionId} -- {prompt}',
        'claude --resume {sessionId}',
      ),
      sessionId: 'sid',
      resume: false,
      initialPrompt: prompt,
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })

    expect(cmd).toContain(`-- '${prompt}'`)
    // One command option plus the prompt's literal mention.
    expect(cmd.match(/--dangerously-load-development-channels server:nats/g)).toHaveLength(2)
  })

  it('keeps Marshal persona and provider flags single when its template pre-bakes both', () => {
    const marshal = tmpl(
      'claude --dangerously-load-development-channels server:nats --append-system-prompt {agentPrompt} --session-id {sessionId} -- {prompt}',
      'claude --dangerously-load-development-channels server:nats --append-system-prompt {agentPrompt} --resume {sessionId}',
    )
    const cmd = buildAgentCommand({
      template: marshal, sessionId: 'sid', resume: false, initialPrompt: 'marshal this',
      agent: AGENT, appendSystemPrompt: AGENT.prompt,
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })

    expect(cmd.match(/--dangerously-load-development-channels server:nats/g)).toHaveLength(1)
    expect(cmd.match(/--append-system-prompt/g)).toHaveLength(1)
    expect(cmd.match(/BE THE MARSHAL/g)).toHaveLength(1)
  })

  it('leaves a template without a baked enable flag byte-identical when NATS is disabled', () => {
    const template = tmpl(
      'claude --dangerously-skip-permissions --session-id {sessionId} -- {prompt}',
      'claude --dangerously-skip-permissions --resume {sessionId}',
    )
    const base = { template, sessionId: 'sid', resume: false, initialPrompt: 'my prompt' } as const

    expect(buildAgentCommand({ ...base, nats: { enabled: false } })).toBe(buildAgentCommand(base))
  })

  it('uses a supported provider\'s custom enable, config, and disabled-pattern syntax', () => {
    const provider: TerminalProviderAdapter = {
      provider: { id: 'forge', label: 'Forge' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: {
            state: 'supported',
            detail: {
              transport: 'forge-channel',
              command: {
                enableFlag: '--channel nats',
                configFlag: '--channel-config',
                disabledPattern: /\s*--channel\s+nats/g,
                autoAcceptWarning: false,
              },
            },
          },
          telemetry: { state: 'unsupported', reason: 'not needed for this test' },
        },
        defaultTelemetry: false,
        transcript: null,
      },
    }
    const template: CliTemplate = {
      id: 'forge',
      name: 'Forge', adapter: 'forge',
      startCmd: 'forge --channel nats run -- {prompt}',
      resumeCmd: 'forge resume',
    }
    const cmd = buildAgentCommand({
      provider, template, initialPrompt: 'go',
      nats: { enabled: true, mcpConfigPath: '/cfg/forge.json' },
    })

    expect(cmd).toBe("forge run --channel nats --channel-config '/cfg/forge.json' -- 'go'")
    expect(cmd.match(/--channel nats/g)).toHaveLength(1)
  })

  it('rejects NATS for a generic/cursor provider instead of silently dropping its config', () => {
    const cursor: CliTemplate = { id: 'cursor-agent', name: 'Cursor Agent', adapter: 'generic', startCmd: 'agent --yolo -- {prompt}', resumeCmd: 'agent --yolo resume' }
    expect(() => buildAgentCommand({
      template: cursor, sessionId: 'sid', resume: false, initialPrompt: 'do cmsandbox work',
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })).toThrow('Provider "generic" does not support terminal capability "nats"')
  })

  it('rejects NATS for Codex instead of silently dropping its config', () => {
    const codex: CliTemplate = { id: 'codex-full-auto', name: 'Codex (full auto)', adapter: 'codex', startCmd: 'codex --sandbox workspace-write -- {prompt}', resumeCmd: 'codex resume --last --sandbox workspace-write' }
    expect(() => buildAgentCommand({
      template: codex, sessionId: 'sid', resume: false, initialPrompt: 'do the work',
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })).toThrow('Provider "codex" does not support terminal capability "nats"')
  })

  it('legacy fallback (no template) includes both flags when NATS is provisioned', () => {
    const cmd = buildAgentCommand({
      skipPermissions: true, sessionId: 'sid', resume: false, initialPrompt: 'hi',
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })
    expect(cmd).toContain('--dangerously-load-development-channels server:nats')
    expect(cmd).toContain("--mcp-config '/cfg/nats-mcp.json'")
  })
})

describe('buildAgentCommand flag-insertion robustness', () => {
  const PLAIN = tmpl('claude --session-id {sessionId} -- {prompt}', 'claude --resume {sessionId}')

  it("a ' -- ' inside the --mcp-config path does not corrupt the command", () => {
    // A session name with a literal ' -- ' flows into the per-session config path.
    // The real prompt separator must stay the last ` -- `, with append/model as
    // options before it and the path spliced in intact.
    const cmd = buildAgentCommand({
      template: PLAIN, sessionId: 'sid', resume: false, initialPrompt: 'do it',
      nats: { enabled: true, mcpConfigPath: "/sessions/weird -- name/nats-mcp.json" },
      appendSystemPrompt: 'BE X', modelOverride: 'haiku',
    })
    // The path (including its ' -- ') survives as one quoted token.
    expect(cmd).toContain("--mcp-config '/sessions/weird -- name/nats-mcp.json'")
    // The real separator + prompt is intact and last.
    expect(cmd.endsWith("-- 'do it'")).toBe(true)
    // append-system-prompt and model landed as options, before the real separator.
    const sepIdx = cmd.lastIndexOf(" -- ")
    expect(cmd.indexOf('--append-system-prompt')).toBeGreaterThan(-1)
    expect(cmd.indexOf('--append-system-prompt')).toBeLessThan(sepIdx)
    expect(cmd.indexOf('--model')).toBeLessThan(sepIdx)
  })

  it("does not mistake ' -- ' inside an interpolated persona for the prompt boundary", () => {
    const cmd = buildAgentCommand({
      template: tmpl(
        'claude --append-system-prompt {agentPrompt} --session-id {sessionId} -- {prompt}',
        'claude --resume {sessionId}',
      ),
      sessionId: 'sid',
      resume: false,
      initialPrompt: 'go',
      agent: { ...AGENT, prompt: 'persona says -- keep this' },
      nats: { enabled: true, mcpConfigPath: '/cfg/nats.json' },
    })

    expect(cmd).toContain("--append-system-prompt 'persona says -- keep this'")
    expect(cmd).toContain('--dangerously-load-development-channels server:nats')
    expect(cmd).toContain("--mcp-config '/cfg/nats.json'")
    expect(cmd.endsWith("-- 'go'")).toBe(true)
  })

  it('single-quotes (escapes) shell metacharacters in the --mcp-config path', () => {
    const cmd = buildAgentCommand({
      template: PLAIN, sessionId: 'sid', resume: false, initialPrompt: 'p',
      nats: { enabled: true, mcpConfigPath: "/a/o'brien/nats-mcp.json" },
    })
    // bashSingleQuote turns ' into '\'' — a regression that dropped quoting would fail this.
    expect(cmd).toContain("--mcp-config '/a/o'\\''brien/nats-mcp.json'")
  })

  it('strips the dev-channels flag cleanly when it is the last token (no trailing space)', () => {
    const cmd = buildAgentCommand({
      template: tmpl('claude --session-id {sessionId} --dangerously-load-development-channels server:nats', 'claude --resume {sessionId}'),
      sessionId: 'sid', resume: false, nats: null,
    })
    expect(cmd).toBe('claude --session-id sid')
    expect(cmd).not.toMatch(/ $/)
  })
})
