import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CODEX_TINSTAR_MCP_SERVER_ID, codexMcpLaunchFlags } from '../codex-mcp'

describe('Codex standard MCP launch configuration', () => {
  it('translates the managed server descriptor into per-run Codex config overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-'))
    const configPath = join(dir, 'nats-mcp.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        nats: {
          command: "/opt/bun's/bin/bun",
          args: ['x', 'nats-channel-mcp', '--name', 'worker'],
          env: {
            TINSTAR_NATS_URL: 'nats://127.0.0.1:4222',
            TINSTAR_MESSAGE_ROUTER_AUTH: "secret'value",
          },
        },
      },
    }))

    const flags = codexMcpLaunchFlags(configPath)
    expect(flags).toEqual([
      `-c 'mcp_servers.${CODEX_TINSTAR_MCP_SERVER_ID}={command="/opt/bun'\\''s/bin/bun",args=["x","nats-channel-mcp","--name","worker"],env_vars=["TINSTAR_MESSAGE_ROUTER_AUTH","TINSTAR_NATS_URL"],env={},enabled_tools=["reply"],disabled_tools=[],enabled=true,required=true}'`,
      `-c 'mcp_servers.${CODEX_TINSTAR_MCP_SERVER_ID}.tools.reply.approval_mode="approve"'`,
    ])
    expect(flags.join(' ')).not.toContain('secret')
    expect(flags.join(' ')).not.toContain('mcp_servers.nats')
  })

  it('replaces the complete Tinstar-owned server table instead of inheriting user fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-collision-'))
    const configPath = join(dir, 'nats-mcp.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        nats: {
          command: '/usr/bin/bun',
          args: ['x', 'nats-channel-mcp'],
          env: { TINSTAR_MESSAGE_ROUTER_AUTH: 'router-secret' },
        },
      },
    }))

    const commandLine = codexMcpLaunchFlags(configPath).join(' ')
    expect(commandLine).toContain(`mcp_servers.${CODEX_TINSTAR_MCP_SERVER_ID}={`)
    expect(commandLine).toContain('env={}')
    expect(commandLine).toContain('disabled_tools=[]')
    expect(commandLine).not.toContain('mcp_servers.nats')
    expect(commandLine).not.toContain('router-secret')
    expect(commandLine).not.toContain('url=')
  })

  it('rejects malformed descriptors instead of launching Codex without reply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-bad-'))
    const configPath = join(dir, 'nats-mcp.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: { nats: { command: '', args: [] } } }))

    expect(() => codexMcpLaunchFlags(configPath)).toThrow('valid nats MCP server')
  })
})
