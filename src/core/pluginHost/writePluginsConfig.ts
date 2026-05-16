import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginsConfig } from './pluginsConfig'

/** Atomic write: stage to <path>.tmp then rename to <path>. */
export function writePluginsConfig(configRoot: string, config: PluginsConfig): void {
  mkdirSync(configRoot, { recursive: true })
  const final = join(configRoot, 'plugins.json')
  const staging = final + '.tmp'
  writeFileSync(staging, JSON.stringify(config, null, 2), 'utf8')
  renameSync(staging, final)
}
