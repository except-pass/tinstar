import { randomUUID } from 'node:crypto'

export function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}
