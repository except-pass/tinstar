import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getConfigRoot } from '../configRoot'

export interface PortWindow {
  label: string
  start: number
  count: number
}

export interface FleetConfig {
  firstmate: {
    homes: string[]
    ports: { start: number; count: number }
  }
}

export function loadFleetConfig(root = getConfigRoot()): FleetConfig {
  let raw: Record<string, unknown> = {}
  try { raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) } catch { /* defaults */ }
  const firstmate = raw.firstmate && typeof raw.firstmate === 'object'
    ? raw.firstmate as Record<string, unknown> : {}
  const ports = firstmate.ports && typeof firstmate.ports === 'object'
    ? firstmate.ports as Record<string, unknown> : {}
  const start = ports.start
  const count = ports.count
  const valid = Number.isInteger(start) && Number.isInteger(count)
    && (start as number) >= 1024 && (count as number) >= 1
    && (start as number) + (count as number) - 1 <= 65535
  return {
    firstmate: {
      homes: Array.isArray(firstmate.homes)
        ? firstmate.homes.filter((home): home is string => typeof home === 'string' && isAbsolute(home))
        : [],
      ports: valid ? { start: start as number, count: count as number } : { start: 8781, count: 50 },
    },
  }
}

export function firstmatePortWindow(config: FleetConfig): PortWindow {
  return { label: 'firstmate-observer', ...config.firstmate.ports }
}
