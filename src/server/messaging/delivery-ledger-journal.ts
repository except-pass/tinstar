import { createHash } from 'node:crypto'
import type { DeliveryMessage, DeliveryRecord } from './delivery-ledger'

export const DELIVERY_LEDGER_JOURNAL_VERSION = 1
export const DELIVERY_LEDGER_JOURNAL_FILE = 'delivery-ledger.journal'
export const EMPTY_JOURNAL_HASH = '0'.repeat(64)

const CHECKPOINT_KEYS = new Set(['generation', 'sequence', 'hash'])
const ENTRY_KEYS = new Set([
  'version', 'generation', 'sequence', 'previousHash', 'patch', 'hash',
])
const PATCH_KEYS = new Set([
  'upsertMessages', 'upsertDeliveries', 'deleteMessageIds', 'deleteDeliveryIds',
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export interface DeliveryJournalCheckpoint {
  generation: string
  sequence: number
  hash: string
}

export interface DeliveryJournalPatch {
  upsertMessages: DeliveryMessage[]
  upsertDeliveries: DeliveryRecord[]
  deleteMessageIds: string[]
  deleteDeliveryIds: string[]
}

interface DeliveryJournalEntryCore {
  version: typeof DELIVERY_LEDGER_JOURNAL_VERSION
  generation: string
  sequence: number
  previousHash: string
  patch: DeliveryJournalPatch
}

export interface DeliveryJournalEntry extends DeliveryJournalEntryCore {
  hash: string
}

export interface DeliveryJournalProblem {
  path: string
  kind: 'missing' | 'unparsable' | 'unknown-version' | 'malformed'
  detail: string
}

export type DeliveryJournalRead =
  | {
    ok: true
    entries: DeliveryJournalEntry[]
    tornTail: boolean
  }
  | { ok: false; problem: DeliveryJournalProblem }

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function uniqueNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length
}

function journalHash(core: DeliveryJournalEntryCore): string {
  return createHash('sha256').update(JSON.stringify(core)).digest('hex')
}

export function isDeliveryJournalCheckpoint(
  value: unknown,
): value is DeliveryJournalCheckpoint {
  if (!value || typeof value !== 'object' || !hasOnlyKeys(value, CHECKPOINT_KEYS)) {
    return false
  }
  const checkpoint = value as Partial<DeliveryJournalCheckpoint>
  return nonEmpty(checkpoint.generation)
    && Number.isSafeInteger(checkpoint.sequence)
    && (checkpoint.sequence ?? -1) >= 0
    && typeof checkpoint.hash === 'string'
    && SHA256_PATTERN.test(checkpoint.hash)
    && (checkpoint.sequence !== 0 || checkpoint.hash === EMPTY_JOURNAL_HASH)
}

function isPatch(
  value: unknown,
  isMessage: (candidate: unknown) => candidate is DeliveryMessage,
  isDelivery: (candidate: unknown) => candidate is DeliveryRecord,
): value is DeliveryJournalPatch {
  if (!value || typeof value !== 'object' || !hasOnlyKeys(value, PATCH_KEYS)) {
    return false
  }
  const patch = value as Partial<DeliveryJournalPatch>
  if (!Array.isArray(patch.upsertMessages)
    || !patch.upsertMessages.every(isMessage)
    || !Array.isArray(patch.upsertDeliveries)
    || !patch.upsertDeliveries.every(isDelivery)
    || !uniqueNonEmptyStrings(patch.deleteMessageIds)
    || !uniqueNonEmptyStrings(patch.deleteDeliveryIds)) return false

  const upsertMessageIds = patch.upsertMessages.map(message => message.id)
  const upsertDeliveryIds = patch.upsertDeliveries.map(delivery => delivery.id)
  return new Set(upsertMessageIds).size === upsertMessageIds.length
    && new Set(upsertDeliveryIds).size === upsertDeliveryIds.length
    && !upsertMessageIds.some(id => patch.deleteMessageIds!.includes(id))
    && !upsertDeliveryIds.some(id => patch.deleteDeliveryIds!.includes(id))
    && (upsertMessageIds.length > 0
      || upsertDeliveryIds.length > 0
      || patch.deleteMessageIds.length > 0
      || patch.deleteDeliveryIds.length > 0)
}

function parseEntry(
  raw: string,
  path: string,
  line: number,
  isMessage: (candidate: unknown) => candidate is DeliveryMessage,
  isDelivery: (candidate: unknown) => candidate is DeliveryRecord,
): { ok: true; entry: DeliveryJournalEntry } | { ok: false; problem: DeliveryJournalProblem } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'unparsable',
        detail: `journal line ${line}: ${(error as Error).message}`,
      },
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      problem: { path, kind: 'malformed', detail: `journal line ${line} is not an object` },
    }
  }
  const candidate = parsed as Partial<DeliveryJournalEntry>
  if (candidate.version !== DELIVERY_LEDGER_JOURNAL_VERSION) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'unknown-version',
        detail: `journal line ${line}: expected version `
          + `${DELIVERY_LEDGER_JOURNAL_VERSION}, got ${String(candidate.version)}`,
      },
    }
  }
  if (!hasOnlyKeys(parsed, ENTRY_KEYS)
    || !nonEmpty(candidate.generation)
    || !Number.isSafeInteger(candidate.sequence)
    || (candidate.sequence ?? 0) < 1
    || typeof candidate.previousHash !== 'string'
    || !SHA256_PATTERN.test(candidate.previousHash)
    || !isPatch(candidate.patch, isMessage, isDelivery)
    || typeof candidate.hash !== 'string'
    || !SHA256_PATTERN.test(candidate.hash)) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'malformed',
        detail: `journal line ${line} contains an invalid record`,
      },
    }
  }
  const core: DeliveryJournalEntryCore = {
    version: DELIVERY_LEDGER_JOURNAL_VERSION,
    generation: candidate.generation,
    sequence: candidate.sequence!,
    previousHash: candidate.previousHash,
    patch: candidate.patch,
  }
  if (journalHash(core) !== candidate.hash) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'malformed',
        detail: `journal line ${line} failed its integrity check`,
      },
    }
  }
  return { ok: true, entry: { ...core, hash: candidate.hash } }
}

export function readDeliveryJournal(
  raw: Buffer,
  path: string,
  isMessage: (candidate: unknown) => candidate is DeliveryMessage,
  isDelivery: (candidate: unknown) => candidate is DeliveryRecord,
): DeliveryJournalRead {
  if (raw.length === 0) {
    return { ok: true, entries: [], tornTail: false }
  }
  const text = raw.toString('utf8')
  const tornTail = !text.endsWith('\n')
  const complete = tornTail ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  const lines = complete.length === 0 ? [] : complete.slice(0, -1).split('\n')
  const entries: DeliveryJournalEntry[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.length === 0) {
      return {
        ok: false,
        problem: {
          path,
          kind: 'malformed',
          detail: `journal line ${index + 1} is empty`,
        },
      }
    }
    const parsed = parseEntry(line, path, index + 1, isMessage, isDelivery)
    if (!parsed.ok) return parsed
    const previous = entries.at(-1)
    if (previous && (parsed.entry.generation !== previous.generation
      || parsed.entry.sequence !== previous.sequence + 1
      || parsed.entry.previousHash !== previous.hash)) {
      return {
        ok: false,
        problem: {
          path,
          kind: 'malformed',
          detail: `journal line ${index + 1} does not continue the prior record`,
        },
      }
    }
    entries.push(parsed.entry)
  }
  return { ok: true, entries, tornTail }
}

export function createDeliveryJournalEntry(
  checkpoint: DeliveryJournalCheckpoint,
  patch: DeliveryJournalPatch,
): DeliveryJournalEntry {
  const core: DeliveryJournalEntryCore = {
    version: DELIVERY_LEDGER_JOURNAL_VERSION,
    generation: checkpoint.generation,
    sequence: checkpoint.sequence + 1,
    previousHash: checkpoint.hash,
    patch,
  }
  return { ...core, hash: journalHash(core) }
}

export function serializeDeliveryJournalEntry(entry: DeliveryJournalEntry): Buffer {
  return Buffer.from(`${JSON.stringify(entry)}\n`)
}
