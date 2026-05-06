// bin/configRoot.js — CLI-side mirror of src/server/configRoot.ts
// Resolves the Tinstar config root directory, honoring TINSTAR_CONFIG_HOME
// (preferred) and the legacy TINSTAR_DATA_DIR alias.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function getConfigRoot() {
  const override = process.env.TINSTAR_CONFIG_HOME
  if (override && override.length > 0) return override
  const legacy = process.env.TINSTAR_DATA_DIR
  if (legacy && legacy.length > 0) return legacy
  return join(homedir(), '.config', 'tinstar')
}
