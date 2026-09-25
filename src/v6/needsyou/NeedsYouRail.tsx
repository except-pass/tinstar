import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../apiClient'
import { isRecord } from '../contract/result'
import type { ShellWorkerIdentity } from '../shell/identity'
import { WorkerFace } from '../shell/WorkerFace'
import { BlockedCard } from './BlockedCard'
import { ContradictionCard } from './ContradictionCard'
import { DecisionCard } from './DecisionCard'
import { FailureCard } from './FailureCard'
import { ReviewReadyCard } from './ReviewReadyCard'
import { ScheduleDriftCard } from './ScheduleDriftCard'
import {
  newRequestId,
  prepareAnswer,
  projectSubmission,
  readEntry,
  type AttentionRow,
  type InboxSubmission,
  type RailEntry,
} from './model'
import type { AttentionCommit } from './useAnswerState'

export interface AnswerPost {
  revision: string
  requestId: string
  kind: 'attention.answer' | 'schedule.acknowledge'
  body: Record<string, unknown>
}

export interface NeedsYouHttp {
  list(): Promise<unknown>
  answer(id: string, body: AnswerPost): Promise<unknown>
}

export type RailSubmitIntent = (raw: unknown) => Promise<InboxSubmission>

export interface NeedsYouRailProps {
  /** When set, the rail renders these records and does not fetch. */
  items?: readonly unknown[]
  /** Direct inbox client. Used when `http` is omitted. */
  submitIntent?: RailSubmitIntent
  /** Route client. Production uses `apiFetch` when both props are omitted. */
  http?: NeedsYouHttp
  /** Rail identity keyed by worker id. Provenance paints this and does not mint another. */
  identities?: Record<string, ShellWorkerIdentity>
}

const defaultHttp: NeedsYouHttp = {
  async list() {
    const res = await apiFetch('/api/v6/needsyou')
    return res.json() as Promise<unknown>
  },
  async answer(id, body) {
    const res = await apiFetch(`/api/v6/needsyou/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json() as Promise<unknown>
  },
}

function errorMessage(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message
  }
  return 'answer failed'
}

function rowsFromList(payload: unknown): RailEntry[] {
  const items = isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.items)
    ? payload.data.items
    : []
  return items.map((raw, index) => readEntry(raw, index))
}

function rowFromAnswer(current: AttentionRow, payload: unknown): AttentionRow | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) return null
  const entry = readEntry({ ...payload.data, fixture: payload.data.fixture === true || current.fixture }, 0)
  return entry.kind === 'item' ? entry.row : null
}

function TypedCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  switch (row.item.type) {
    case 'decision':
      return <DecisionCard row={row} commit={commit} />
    case 'blocked':
      return <BlockedCard row={row} commit={commit} />
    case 'failure':
      return <FailureCard row={row} commit={commit} />
    case 'schedule-drift':
      return <ScheduleDriftCard row={row} commit={commit} />
    case 'contradiction':
      return <ContradictionCard row={row} commit={commit} />
    case 'review-ready':
      return <ReviewReadyCard row={row} commit={commit} />
  }
}

function ProvenanceIdentity({
  itemId,
  workerId,
  identities,
}: {
  itemId: string
  workerId: string | undefined
  identities: Record<string, ShellWorkerIdentity>
}) {
  if (!workerId) return null
  const identity = identities[workerId]
  if (!identity) return null
  return (
    <p
      data-testid={`needsyou-provenance-${itemId}`}
      data-identity="worker"
      data-color={identity.color}
      data-name={identity.name}
      className="flex items-center gap-2 rounded border-2 px-2 py-1"
      style={{ borderColor: identity.color }}
    >
      <WorkerFace id={workerId} color={identity.color} />
      <span className="min-w-0">
        <span className="block truncate">{identity.name}</span>
        <span className="block truncate text-xs">{identity.project}</span>
        <span className="block truncate text-xs">{identity.worktree}</span>
      </span>
    </p>
  )
}

export function NeedsYouRail({ items, submitIntent, http, identities = {} }: NeedsYouRailProps) {
  const controlled = items !== undefined
  const [entries, setEntries] = useState<RailEntry[]>(() => (items ?? []).map((raw, index) => readEntry(raw, index)))
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestIds = useRef(new Map<string, string>())

  useEffect(() => {
    if (controlled) {
      setEntries((items ?? []).map((raw, index) => readEntry(raw, index)))
      return
    }
    let cancel = false
    const client = http ?? defaultHttp
    void client.list().then(payload => {
      if (cancel) return
      if (isRecord(payload) && payload.ok === false) {
        setLoadError(errorMessage(payload))
        return
      }
      setEntries(rowsFromList(payload))
    }).catch((err: unknown) => {
      if (!cancel) setLoadError(err instanceof Error ? err.message : 'Needs You failed to load')
    })
    return () => {
      cancel = true
    }
  }, [controlled, items, http])

  function requestIdFor(key: string): string {
    const existing = requestIds.current.get(key)
    if (existing) return existing
    const next = newRequestId()
    requestIds.current.set(key, next)
    return next
  }

  const commit: AttentionCommit = async (row, kind, body, key) => {
    const requestId = requestIdFor(`${row.item.id}:${key}`)
    if (submitIntent && !http) {
      const prepared = prepareAnswer({
        item: row.item,
        seenRevision: row.item.revision,
        requestId,
        kind,
        body,
      })
      if (!prepared.ok) return { row, error: `${prepared.diagnostic}. Not applied.` }
      const submission = await submitIntent(prepared.envelope)
      const next = projectSubmission(row, prepared, { ...submission, applied: false }, new Date().toISOString())
      const failed = submission.disposition === 'failed' || submission.noteId === null
      return { row: next, error: failed ? submission.detail : null }
    }
    const client = http ?? defaultHttp
    const payload = await client.answer(row.item.id, {
      revision: row.item.revision,
      requestId,
      kind,
      body,
    })
    if (!isRecord(payload) || payload.ok !== true) return { row, error: errorMessage(payload) }
    const next = rowFromAnswer(row, payload) ?? row
    const detail = isRecord(payload.data) && typeof payload.data.detail === 'string' ? payload.data.detail : null
    const failed = next.delivery === 'failed'
    return { row: next, error: failed ? detail : null }
  }

  return (
    <section data-testid="needsyou-rail" aria-label="Needs You" className="flex flex-col gap-2 bg-surface-base p-2">
      <h2 className="font-display text-xs uppercase tracking-wider text-primary">Needs You</h2>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {entries.length === 0 ? <p data-testid="needsyou-empty">No attention items</p> : null}
      {entries.map(entry => entry.kind === 'diagnostic' ? (
        <article key={entry.id} data-testid={`needsyou-diagnostic-${entry.id}`} data-kind="diagnostic" role="alert" className="border border-hue-error bg-surface-panel px-3 py-2">
          {entry.fixture ? <span data-testid="needsyou-fixture">fixture</span> : null}
          <p className="font-display text-hue-error">Needs You diagnostic</p>
          <p>{entry.diagnostic}</p>
        </article>
      ) : (
        <div key={entry.row.item.id} className="flex flex-col gap-1">
          <ProvenanceIdentity
            itemId={entry.row.item.id}
            workerId={entry.row.item.provenance.workerId}
            identities={identities}
          />
          <TypedCard row={entry.row} commit={commit} />
        </div>
      ))}
    </section>
  )
}
