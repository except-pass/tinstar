// Deterministic, zero-token "what this session covered" summary.
//
// There is no server-side LLM/summarization helper in this codebase, and the
// recap convention is deliberately zero-cost. This builds a short, searchable
// summary from the recap entries already in the docstore at retire-time (first
// user ask + last agent turn + counts), falling back to task/persona metadata
// when there are no recorded turns. Pure and stable: same inputs → same output.

import type { RecapEntry } from '../../domain/types'

export interface CoversSummaryMeta {
  sessionName?: string
  task?: string
  epic?: string
  initiative?: string
  /** Persona/agent description or prompt, when the session was a hand. */
  persona?: string
}

const MAX_QUOTE = 220

/** Collapse whitespace and clip to a bound, adding an ellipsis when clipped. */
function clip(text: string, max = MAX_QUOTE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1).trimEnd() + '…'
}

/** Non-empty, ordered, de-duplicated list of metadata labels. */
function metaContext(meta: CoversSummaryMeta): string {
  const parts = [meta.task, meta.epic, meta.initiative].filter(
    (p): p is string => !!p && p.trim().length > 0,
  )
  return [...new Set(parts)].join(' › ')
}

export function buildCoversSummary(
  recapEntries: RecapEntry[],
  meta: CoversSummaryMeta = {},
): string {
  const context = metaContext(meta)
  const firstUser = recapEntries.find(e => e.type === 'user' && e.content.trim())
  const lastAgent = [...recapEntries].reverse().find(e => e.type === 'agent' && e.content.trim())
  const turns = recapEntries.filter(e => e.type === 'user').length
  const tools = recapEntries.reduce((n, e) => n + (e.type === 'agent' ? e.toolUses ?? 0 : 0), 0)

  // No recorded conversation — fall back to derived signals only (R6).
  if (!firstUser && !lastAgent) {
    const derived = [context, meta.persona ? clip(meta.persona) : '']
      .filter(Boolean)
      .join(' — ')
    if (derived) return derived
    return meta.sessionName ? `Session ${meta.sessionName} — no recorded activity.` : 'No recorded activity.'
  }

  const segments: string[] = []
  if (context) segments.push(context)
  if (firstUser) segments.push(`Asked: “${clip(firstUser.content)}”`)
  if (lastAgent) segments.push(`Last: “${clip(lastAgent.content)}”`)

  const counts: string[] = []
  if (turns > 0) counts.push(`${turns} turn${turns === 1 ? '' : 's'}`)
  if (tools > 0) counts.push(`${tools} tool use${tools === 1 ? '' : 's'}`)
  if (counts.length) segments.push(`(${counts.join(', ')})`)

  return segments.join(' — ')
}
