import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../configRoot'
import {
  NEEDS_YOU_STORE_SCHEMA,
  type AttentionRow,
} from '../../../v6/needsyou/model'
import { isRecord } from '../../../v6/contract/result'

export interface AttentionDoc {
  schema: typeof NEEDS_YOU_STORE_SCHEMA
  items: AttentionRow[]
}

export function defaultAttentionDir(): string {
  return join(getConfigRoot(), 'v6', 'needsyou')
}

export function attentionFile(dir: string): string {
  return join(dir, 'items.json')
}

export function emptyAttention(): AttentionDoc {
  return { schema: NEEDS_YOU_STORE_SCHEMA, items: [] }
}

export function readAttention(dir: string): AttentionDoc {
  const file = attentionFile(dir)
  if (!existsSync(file)) return emptyAttention()
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!isRecord(raw) || raw.schema !== NEEDS_YOU_STORE_SCHEMA || !Array.isArray(raw.items)) {
    throw new Error('needs you store schema is not tinstar.v6.needsyou/1')
  }
  return { schema: NEEDS_YOU_STORE_SCHEMA, items: raw.items as AttentionRow[] }
}

function writeAttention(dir: string, doc: AttentionDoc): void {
  const file = attentionFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(doc))
  renameSync(tmp, file)
}

const chains = new Map<string, Promise<unknown>>()

export function mutateAttention<T>(dir: string, mutate: (doc: AttentionDoc) => T): Promise<T> {
  const previous = chains.get(dir) ?? Promise.resolve()
  const run = previous.then(() => {
    const doc = readAttention(dir)
    const result = mutate(doc)
    writeAttention(dir, doc)
    return result
  })
  chains.set(dir, run.then(() => undefined, () => undefined))
  return run
}
