import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../configRoot'
import type { AnchorType } from '../../../v6/contract/intent'
import type { TextSelection, TurnDisposition } from '../../../v6/threads/types'

export const THREADS_SCHEMA = 'tinstar.v6.threads/1' as const

export interface StoredReply {
  noteId: string
  body: string
  cursor: string
  at: string
}

export interface StoredTurn {
  requestId: string
  noteId: string | null
  previousNoteId: string | null
  text: string
  at: string
  disposition: TurnDisposition
  detail: string
  reply: StoredReply | null
}

export interface StoredThread {
  id: string
  anchor: {
    type: AnchorType
    ids: string[]
    textSelection: TextSelection | null
    revision: string | null
    labels: string[]
  }
  turns: StoredTurn[]
  fixture: boolean
  createdAt: string
  updatedAt: string
  display: {
    status: 'current' | 'changed'
    changedLine: string | null
    position: { columnId: string | null; index: number | null } | null
  }
}

export interface ThreadDoc {
  schema: typeof THREADS_SCHEMA
  threads: StoredThread[]
}

export function defaultThreadStoreFile(): string {
  return join(getConfigRoot(), 'v6', 'threads.json')
}

export function emptyThreadDoc(): ThreadDoc {
  return { schema: THREADS_SCHEMA, threads: [] }
}

export function readThreadDoc(file: string): ThreadDoc {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyThreadDoc()
    const doc = raw as Partial<ThreadDoc>
    if (doc.schema !== THREADS_SCHEMA || !Array.isArray(doc.threads)) return emptyThreadDoc()
    return { schema: THREADS_SCHEMA, threads: doc.threads }
  } catch {
    return emptyThreadDoc()
  }
}

export function writeThreadDoc(file: string, doc: ThreadDoc): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(doc), 'utf8')
  renameSync(tmp, file)
}

let chain: Promise<unknown> = Promise.resolve()

/** One writer at a time so a replay cannot append a second turn. */
export function serializeThreads<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.then(() => undefined, () => undefined)
  return run
}
