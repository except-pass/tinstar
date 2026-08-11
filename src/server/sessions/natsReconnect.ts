// Recover a session whose NATS control socket is orphaned (running session, but
// its channel-server MCP's control listener is wedged — see classifyNatsSocketError).
//
// The lever: SIGTERM the session's channel-server process. With the upstream
// clean-exit-on-transport-close fix, it unlinks its socket and exits; Claude
// Code then relaunches the MCP from the session's nats-mcp.json (loaded via
// --mcp-config), binding a fresh socket. A permanent orphan becomes a brief gap.
//
// We match the process by its unique --control-socket path (one per session),
// so we never touch another session's channel-server or the tinstar host.
//
// Same lever runs on session stop/delete and as a start/create preflight: Codex
// (and friends) spawn nats-channel-mcp as a child that often reparents to
// systemd --user when the agent exits, keeping `/tmp/tinstar-nats-<session>.sock`
// forever. tmux kill-session does not reap those grandchildren, so the next
// required-MCP start dies with "control socket … already in use".

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { natsControlSocketPath } from './nats-control'

const execFileAsync = promisify(execFile)

export interface ReconnectDeps {
  /** Unique control-socket path for the session — used to match the process. */
  socketPath: string
  /** List PIDs whose full command line contains `needle`. Injectable for tests. */
  findPids?: (needle: string) => Promise<number[]>
  /** Send a signal to a pid. Injectable for tests. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Keep only channel-server PIDs. Codex embeds `--control-socket <path>` in its
 * own argv, so a bare socket-path `pgrep -f` would SIGTERM the agent — the exact
 * failure that made `/nats-reconnect` lethal for codex-full-auto sessions.
 */
export function filterChannelServerPids(
  pids: number[],
  readCmdline: (pid: number) => string = (pid) => readFileSync(`/proc/${pid}/cmdline`, 'utf8'),
): number[] {
  const out: number[] = []
  for (const pid of pids) {
    try {
      if (readCmdline(pid).includes('nats-channel-mcp')) out.push(pid)
    } catch {
      /* process may have exited between pgrep and the read */
    }
  }
  return out
}

/** Default: `pgrep -f -- <needle>`, then keep only nats-channel-mcp processes. */
async function defaultFindPids(needle: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', '--', needle])
    const candidates = stdout
      .split('\n')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0)
    return filterChannelServerPids(candidates)
  } catch {
    // pgrep exits non-zero when nothing matches — that's "no process", not an error.
    return []
  }
}

/**
 * SIGTERM the channel-server process(es) bound to this session's control socket.
 * Returns the PIDs signalled (empty if none were found — e.g. already gone).
 * Never throws into the caller; individual kill failures are swallowed.
 */
export async function reconnectSessionNats(
  sessionName: string,
  deps: ReconnectDeps,
): Promise<{ sessionName: string; killed: number[] }> {
  const find = deps.findPids ?? defaultFindPids
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig))
  const ownPid = process.pid
  const pids = (await find(deps.socketPath)).filter(pid => pid !== ownPid)
  for (const pid of pids) {
    try { kill(pid, 'SIGTERM') } catch { /* process may have exited already */ }
  }
  return { sessionName, killed: pids }
}

/**
 * Lifecycle entry point: reclaim this session's NATS control socket before the
 * next channel-server bind (stop/delete teardown, or start/create preflight).
 * Thin wrapper over {@link reconnectSessionNats} with the stable socket path.
 */
export async function reapSessionNatsChannelServer(
  sessionName: string,
  deps: Omit<ReconnectDeps, 'socketPath'> = {},
): Promise<{ sessionName: string; killed: number[] }> {
  return reconnectSessionNats(sessionName, {
    ...deps,
    socketPath: natsControlSocketPath(sessionName),
  })
}
