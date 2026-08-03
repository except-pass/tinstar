import { readFileSync } from 'node:fs'

export const CODEX_TINSTAR_MCP_SERVER_ID = 'tinstar_message_router'

interface ManagedMcpDescriptor {
  mcpServers?: {
    nats?: {
      command?: unknown
      args?: unknown
      env?: unknown
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function override(key: string, value: unknown): string {
  return `-c ${shellQuote(`${key}=${JSON.stringify(value)}`)}`
}

function rawOverride(key: string, tomlValue: string): string {
  return `-c ${shellQuote(`${key}=${tomlValue}`)}`
}

/**
 * Render the existing per-session managed MCP descriptor as standard Codex
 * `--config` overrides. This preserves the user's normal CODEX_HOME, auth, and
 * `codex` / `codex resume` command while keeping session credentials out of the
 * workspace and global config.
 */
export function codexMcpLaunchFlags(configPath: string): string[] {
  let descriptor: ManagedMcpDescriptor
  try {
    descriptor = JSON.parse(readFileSync(configPath, 'utf8')) as ManagedMcpDescriptor
  } catch (error) {
    throw new Error(
      `Codex could not read managed MCP config "${configPath}": ${(error as Error).message}`,
    )
  }

  const server = descriptor.mcpServers?.nats
  if (
    typeof server?.command !== 'string'
    || server.command.length === 0
    || !Array.isArray(server.args)
    || !server.args.every(arg => typeof arg === 'string')
    || (server.env !== undefined && (
      server.env === null
      || typeof server.env !== 'object'
      || Array.isArray(server.env)
      || !Object.entries(server.env).every(([key, value]) => (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string'
      ))
    ))
  ) {
    throw new Error(`Codex requires a valid nats MCP server in "${configPath}"`)
  }

  // Values are injected into the managed tmux pane and forwarded to the MCP
  // process. Only their names belong on the command line, which keeps the
  // per-session router credential out of pane history and process arguments;
  // same-user processes can still inspect the managed process environment.
  const envNames = Object.keys(server.env ?? {}).sort()
  const serverKey = `mcp_servers.${CODEX_TINSTAR_MCP_SERVER_ID}`
  // Replace the complete reserved server table in one override. Dotted
  // leaf-by-leaf overrides merge with an existing table, which could retain a
  // user's `url`, literal `env`, or `disabled_tools`. A Tinstar-owned identity
  // plus a whole-table assignment keeps the user's `mcp_servers.nats` intact
  // and makes the managed server independent of global config residue.
  const serverTable = [
    `command=${JSON.stringify(server.command)}`,
    `args=${JSON.stringify(server.args)}`,
    `env_vars=${JSON.stringify(envNames)}`,
    'env={}',
    `enabled_tools=${JSON.stringify(['reply'])}`,
    'disabled_tools=[]',
    'enabled=true',
    'required=true',
  ].join(',')
  return [
    rawOverride(serverKey, `{${serverTable}}`),
    override(`${serverKey}.tools.reply.approval_mode`, 'approve'),
  ]
}
