import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the root directory for Tinstar's persistent server-side config.
 *
 * Honors `TINSTAR_CONFIG_HOME` when set to a non-empty string, otherwise
 * falls back to `~/.config/tinstar`. The override lets a second backend
 * (rehearsal harness, Tauri local-mode helper, CI) run on the same machine
 * without trampling the primary instance's sessions, projects, or NATS state.
 *
 * Read at use-site (not module-load time) so tests and child processes can
 * vary the env var without restarting the host.
 */
export function getConfigRoot(): string {
  const override = process.env.TINSTAR_CONFIG_HOME
  if (override && override.length > 0) return override
  // Legacy alias retained for backwards compatibility (logger, skill-drafts,
  // server/index.ts have used this since before TINSTAR_CONFIG_HOME existed).
  const legacy = process.env.TINSTAR_DATA_DIR
  if (legacy && legacy.length > 0) return legacy
  return join(homedir(), '.config', 'tinstar')
}
