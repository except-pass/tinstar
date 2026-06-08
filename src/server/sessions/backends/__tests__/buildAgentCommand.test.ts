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
