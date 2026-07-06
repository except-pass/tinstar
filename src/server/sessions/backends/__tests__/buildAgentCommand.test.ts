import { describe, it, expect } from 'vitest'

import { buildAgentCommand } from '../tmux'
import type { AgentDef } from '../tmux'
import type { CliTemplate } from '../../config'

const AGENT: AgentDef = { name: 'marshal', description: 'the marshal', prompt: 'BE THE MARSHAL' }

function tmpl(startCmd: string, resumeCmd: string): CliTemplate {
  return { name: 'marshal', startCmd, resumeCmd }
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

  it('legacy fallback (no template) includes both flags when NATS is provisioned', () => {
    const cmd = buildAgentCommand({
      skipPermissions: true, sessionId: 'sid', resume: false, initialPrompt: 'hi',
      nats: { enabled: true, mcpConfigPath: '/cfg/nats-mcp.json' },
    })
    expect(cmd).toContain('--dangerously-load-development-channels server:nats')
    expect(cmd).toContain("--mcp-config '/cfg/nats-mcp.json'")
  })
})
