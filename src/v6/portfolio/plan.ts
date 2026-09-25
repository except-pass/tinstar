import { isRecord, parsed, rejected, type ParseResult } from '../contract/result'
import type { MergedPlan, MergedPlanTask } from './types'

export const PLAN_SLUG = /^[a-z0-9][a-z0-9-]*$/

function num(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function taskOf(raw: unknown, source: 'tasks' | 'added', state: Record<string, unknown> | null): MergedPlanTask | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null
  const row = state && isRecord(state[raw.id]) ? state[raw.id] as Record<string, unknown> : null
  return {
    id: raw.id,
    label: typeof raw.label === 'string' ? raw.label : '',
    bucket: typeof raw.bucket === 'string' ? raw.bucket : '',
    start: num(raw.start),
    end: num(raw.end),
    source,
    progress: row ? num(row.progress) : null,
    note: row && typeof row.note === 'string' ? row.note : null,
    removed: row?.removed === true,
  }
}

/**
 * Union of `tasks[]` and `_state._addedTasks`, in that order.
 * A missing progress key stays null. An explicit 0 stays 0.
 * Does not write start, end, or progress.
 */
export function mergePlanTasks(plan: unknown): ParseResult<MergedPlan> {
  if (!isRecord(plan)) return rejected('plan must be an object')
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
  const state = isRecord(plan._state) ? plan._state : null
  const added = state && Array.isArray(state._addedTasks) ? state._addedTasks : []
  const merged: MergedPlanTask[] = []
  const seen = new Set<string>()
  for (const raw of tasks) {
    const task = taskOf(raw, 'tasks', state)
    if (!task || seen.has(task.id)) continue
    seen.add(task.id)
    merged.push(task)
  }
  for (const raw of added) {
    const task = taskOf(raw, 'added', state)
    if (!task || seen.has(task.id)) continue
    seen.add(task.id)
    merged.push(task)
  }
  return parsed({ fixture: plan.fixture === true, tasks: merged })
}

export function planPageHref(baseUrl: string, slug: string): string | null {
  if (!PLAN_SLUG.test(slug)) return null
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null
  return new URL(`/p/${slug}`, base).toString()
}

/** https anywhere, and http only for the local Stretch Plan host. */
export function isClickablePlanHref(href: string): boolean {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return Boolean(url.hostname)
  if (url.protocol !== 'http:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
}
