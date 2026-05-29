import { join } from 'node:path'
import { getConfigRoot } from '../configRoot'

export function resolveSlashUsagePath(): string {
  return join(getConfigRoot(), 'slash-usage.json')
}
