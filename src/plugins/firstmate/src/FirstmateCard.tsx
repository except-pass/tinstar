// The first mate worker card. READ-ONLY: it renders `viewData.firstmate`, which the
// server observer owns, and never writes it back (a client patch would be
// overwritten by the next ledger line anyway). Every string here comes verbatim from
// the first mate's status log, so it is rendered as plain text only — never as HTML
// or markdown — and links are limited to https URLs.
import { useState } from 'react'
import type { WidgetProps } from '@tinstar/plugin-api'

interface Decision { key: string; state: string; text: string; ts: number }

/** Mirrors the server's FirstmateCardData (src/server/firstmate/observer.ts);
 *  duplicated per the plugin-api isolation convention (ADR-0002). */
export interface FirstmateCardData {
  task: string
  kind: string | null
  project: string | null
  harness: string | null
  model: string | null
  status: string | null
  statusText: string
  statusTs: number | null
  decisions: Decision[]
  pr: string | null
  merged: { via: string; pr: string | null } | null
  worktree: string | null
  runId?: string
  /** The linked Claude conversation (display only; a heuristic link can be wrong). */
  conversationId?: string | null
  conversationSource?: 'auto' | 'manual' | null
  activity?: 'running' | 'idle' | null
  terminal?: { state: 'live' | 'unavailable'; reason: string | null }
}

interface CardProps { firstmate?: FirstmateCardData }

/** Only https links are made clickable; anything else renders as inert text. */
export function safePrUrl(pr: string | null | undefined): string | null {
  if (!pr) return null
  try {
    const u = new URL(pr)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

export function statusTone(status: string | null): string {
  switch (status) {
    case 'needs-decision':
    case 'blocked':
    case 'failed':
      return 'bg-red-900/60 text-red-200 border-red-700/60'
    case 'done':
      return 'bg-emerald-900/50 text-emerald-200 border-emerald-700/50'
    case 'paused':
      return 'bg-slate-700/60 text-slate-200 border-slate-600/60'
    default:
      return 'bg-sky-900/50 text-sky-200 border-sky-700/50'
  }
}

function orDash(v: string | null | undefined): string {
  return v && v.trim() ? v : '—'
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-slate-400/70">{label}</div>
      <div className="truncate text-xs text-slate-100" title={orDash(value)}>{orDash(value)}</div>
    </div>
  )
}

/** Sends a manual conversation override (null clears it); wired by the plugin entry. */
export type SetConversation = (runId: string, conversationId: string | null) => Promise<boolean>

function ActivityLight({ activity }: { activity: 'running' | 'idle' | null | undefined }) {
  const tone = activity === 'running' ? 'bg-emerald-400 animate-pulse' : activity === 'idle' ? 'bg-amber-400' : 'bg-slate-600'
  const label = activity === 'running' ? 'running' : activity === 'idle' ? 'idle' : 'no conversation linked'
  return <span data-testid="firstmate-activity" data-activity={activity ?? 'none'} title={label} aria-label={label} className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone}`} />
}

function ConversationRow({ fm, setConversation }: { fm: FirstmateCardData; setConversation?: SetConversation }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const save = async (value: string | null) => {
    if (!fm.runId || !setConversation) return
    const ok = await setConversation(fm.runId, value)
    setError(!ok)
    if (ok) setEditing(false)
  }
  return (
    <div data-testid="firstmate-conversation" className="text-xs">
      <span className="text-[10px] uppercase tracking-wider text-slate-400/70">Conversation </span>
      <span className="break-all font-mono" title="Matched heuristically from the worktree's Claude transcripts">
        {fm.conversationId ?? '—'}
      </span>
      {fm.conversationSource === 'manual' && <span className="ml-1 text-slate-400">(manual)</span>}
      {setConversation && fm.runId && !editing && (
        <button type="button" className="ml-2 text-sky-300 underline" onClick={() => { setDraft(''); setError(false); setEditing(true) }}>
          override
        </button>
      )}
      {editing && (
        <span className="ml-2 inline-flex gap-1">
          <input
            aria-label="conversation id" value={draft} onChange={e => setDraft(e.target.value)}
            className="w-56 rounded border border-slate-600 bg-slate-800 px-1 font-mono text-[11px]" placeholder="conversation id"
          />
          <button type="button" className="text-sky-300 underline" onClick={() => void save(draft.trim())}>set</button>
          {fm.conversationSource === 'manual' && (
            <button type="button" className="text-sky-300 underline" onClick={() => void save(null)}>auto</button>
          )}
          <button type="button" className="text-slate-400 underline" onClick={() => setEditing(false)}>cancel</button>
        </span>
      )}
      {error && <span className="ml-2 text-red-300">not found</span>}
    </div>
  )
}

export function FirstmateCard({ data, setConversation }: WidgetProps & { setConversation?: SetConversation }) {
  const fm = (data as CardProps | undefined)?.firstmate
  if (!fm) {
    return <div className="p-3 text-xs text-slate-400" data-testid="firstmate-card-empty">No first mate data</div>
  }
  const prUrl = safePrUrl(fm.pr)
  return (
    <div data-testid="firstmate-card" className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 text-slate-100">
      <div className="widget-drag-handle flex items-center gap-2 border-b border-slate-700 bg-slate-800 px-3 py-2">
        <span className="truncate text-sm font-semibold" title={fm.task}>{fm.task}</span>
        <ActivityLight activity={fm.activity} />
        <span className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${statusTone(fm.status)}`}>
          {fm.merged ? 'merged' : orDash(fm.status)}
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-auto px-3 py-2">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Field label="Kind" value={fm.kind} />
          <Field label="Project" value={fm.project} />
          <Field label="Harness" value={fm.harness} />
          <Field label="Model" value={fm.model} />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400/70">Latest status</div>
          <div data-testid="firstmate-status" className="whitespace-pre-wrap break-words text-xs">{orDash(fm.statusText)}</div>
        </div>
        <ConversationRow fm={fm} setConversation={setConversation} />
        {fm.decisions.length > 0 && (
          <div data-testid="firstmate-decisions">
            <div className="text-[10px] uppercase tracking-wider text-red-300/80">
              Open decisions ({fm.decisions.length}) <span className="normal-case text-slate-500">as reported by the ledger</span>
            </div>
            <ul className="mt-1 space-y-1">
              {fm.decisions.map(d => (
                <li key={d.key} className="rounded border border-red-900/60 bg-red-950/30 px-2 py-1 text-xs">
                  <span className="font-semibold">{d.state}</span>
                  {d.key !== 'default' && <span className="text-slate-400"> [{d.key}]</span>}
                  {d.text && <span className="whitespace-pre-wrap break-words">: {d.text}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {fm.terminal?.state === 'unavailable' && (
          <div data-testid="firstmate-terminal-note" className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] text-slate-300">
            No live terminal{fm.terminal.reason ? `: ${fm.terminal.reason}` : ''}
          </div>
        )}
        {(fm.pr || fm.merged) && (
          <div data-testid="firstmate-pr" className="text-xs">
            <span className="text-[10px] uppercase tracking-wider text-slate-400/70">PR </span>
            {prUrl
              ? <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline break-all">{prUrl}</a>
              : <span className="break-all">{orDash(fm.pr)}</span>}
            <span className="ml-2 text-slate-400">
              {fm.merged ? (fm.merged.via === 'local' ? 'merged (local)' : 'merged') : 'open'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
