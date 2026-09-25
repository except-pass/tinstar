import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../configRoot'
import type { IntentAnchor } from '../../../v6/contract/intent'

export const PROJECTION_SCHEMA = 'tinstar.v6.projection/1' as const

/** Transport state of an inbox note. A receipt, not this field, marks applied. */
export type IntentDisposition = 'queued' | 'saved-unannounced' | 'not-receivable' | 'failed'

export interface StoredIntent {
  requestId: string
  noteId: string | null
  kind: string
  anchor: IntentAnchor
  disposition: IntentDisposition
  at: string
}

export interface StoredIdentity {
  color: string
  alias?: string
}

export interface ProjectionDoc {
  schema: typeof PROJECTION_SCHEMA
  intents: Record<string, StoredIntent>
  identities: Record<string, StoredIdentity>
}

export function defaultProjectionFile(): string {
  return join(getConfigRoot(), 'v6', 'projection.json')
}

export function emptyProjection(): ProjectionDoc {
  return { schema: PROJECTION_SCHEMA, intents: {}, identities: {} }
}

export function readProjection(file: string): ProjectionDoc {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyProjection()
    const doc = raw as Partial<ProjectionDoc>
    return {
      schema: PROJECTION_SCHEMA,
      intents: doc.intents && typeof doc.intents === 'object' ? doc.intents : {},
      identities: doc.identities && typeof doc.identities === 'object' ? doc.identities : {},
    }
  } catch {
    return emptyProjection()
  }
}

let chain: Promise<unknown> = Promise.resolve()

export function updateProjection<T>(file: string, mutate: (doc: ProjectionDoc) => T): Promise<T> {
  const run = chain.then(() => {
    const doc = readProjection(file)
    const result = mutate(doc)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(doc), 'utf8')
    renameSync(tmp, file)
    return result
  })
  chain = run.then(() => undefined, () => undefined)
  return run
}
