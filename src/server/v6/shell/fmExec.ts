import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../configRoot'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Array argv only. Callers never pass a shell string. */
export interface FmCommandRunner {
  exec(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>
}

export const defaultFmRunner: FmCommandRunner = {
  exec(script, args, env) {
    return new Promise(resolve => {
      execFile(script, args, { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = !err ? 0 : typeof err.code === 'number' ? err.code : null
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
  },
}

const STRIPPED_ENV = new Set(['FM_HOME', 'FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_TEST_HOME', 'TMUX'])

/** Force FM_HOME. Drop inherited home overrides so a live checkout cannot leak in. */
export function fmChildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (STRIPPED_ENV.has(key)) continue
    if (key.startsWith('FM_') && key.endsWith('_OVERRIDE')) continue
    env[key] = value
  }
  env.FM_HOME = home
  delete env.TMUX
  return env
}

export interface ResolvedFmHome {
  /** Directory passed as FM_HOME. Never the live First Mate checkout by default. */
  home: string
  /** False when the operator did not point V6 at a home. Do not invent workers. */
  configured: boolean
}

/**
 * `TINSTAR_V6_FM_HOME` when set. Otherwise the isolated projection root, marked
 * unconfigured so snapshot and inbox commands are not launched.
 */
export function resolveV6FmHome(): ResolvedFmHome {
  const explicit = process.env.TINSTAR_V6_FM_HOME?.trim()
  if (explicit) return { home: explicit, configured: true }
  return { home: join(getConfigRoot(), 'v6'), configured: false }
}

/** `FM_V6_BIN` may be the bin directory or a path to one of the scripts. */
export function resolveFmBinDir(): string | null {
  const raw = process.env.FM_V6_BIN?.trim() || process.env.TINSTAR_V6_FM_BIN?.trim()
  if (!raw) return null
  const dir = raw.endsWith('.sh') ? dirname(raw) : raw
  if (!existsSync(join(dir, 'fm-inbox.sh'))) return null
  return dir
}

export function inboxScript(binDir: string): string {
  return join(binDir, 'fm-inbox.sh')
}

export function snapshotScript(binDir: string): string {
  return join(binDir, 'fm-fleet-snapshot.sh')
}
