// The per-POINT answer form (S4 U2) — lifted verbatim out of `OpenPointRow` so the
// vertical open-points list and the multi-question workbench drive answers through
// ONE code path.
//
// Why a hook and not a shared component: the interactive form state A2UI's controls
// read (`NoticeFormState`) is SURFACE-scoped — one `text`, one `submit()` per
// provider. Per-question independence therefore has to come from N independent form
// instances, one per point, not from one form with N slots. This hook IS that
// instance: call it once per point and each caller gets its own `selected` map, its
// own draft `text`, its own in-flight guard, and its own optimistic answered-lock.
// Two columns sharing a workbench never touch each other's state.
//
// The POST target and body are unchanged from the row's original `submitAnswer`:
// `POST /api/runs/:runId/slate/points/:pointId/answer` with `{ choices?, text? }`.
// One submit answers exactly one point, which is precisely one-question-per-column.
import { useCallback, useState } from 'react'
import type { NoticeFormState } from '../../a2ui/controlComponents'
import { apiFetch } from '../../apiClient'

const EMPTY_SET: ReadonlySet<string> = new Set()

export interface PointAnswerForm {
  /** Hand straight to `<A2uiRenderer form={...}>` — the controls read/write it. */
  form: NoticeFormState
  /** Validation or delivery failure, already phrased for the user. */
  error: string | null
  /** True once this point's answer is optimistically in (the Submit shows
   *  "✓ Answered" and every control locks). Local — the durable status arrives on
   *  the next `run.slate` delta. */
  answered: boolean
  /** Lets the host clear a stale error (e.g. when the surface re-projects). */
  setError: (value: string | null) => void
}

/**
 * One independent answer form for ONE point.
 *
 * @param runId   the run the point belongs to (answers are run-scoped)
 * @param pointId the point being answered — the ONLY point this form's submit touches
 */
export function usePointAnswerForm(runId: string, pointId: string): PointAnswerForm {
  // Selection is keyed by the CHOICE component's id so multiple choice groups on one
  // body stay independent (a single-select in one group doesn't wipe the other's).
  const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map())
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [optimisticAnswered, setOptimisticAnswered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleOption = useCallback((choiceId: string, optionId: string, mode: 'single' | 'multi') => {
    setSelected((prev) => {
      const next = new Map(prev)
      const group = new Set(prev.get(choiceId) ?? [])
      if (mode === 'single') {
        next.set(choiceId, new Set([optionId]))
      } else {
        if (group.has(optionId)) group.delete(optionId)
        else group.add(optionId)
        next.set(choiceId, group)
      }
      return next
    })
  }, [])

  const selectedFor = useCallback(
    (choiceId: string): ReadonlySet<string> => selected.get(choiceId) ?? EMPTY_SET,
    [selected],
  )

  const submitAnswer = useCallback(async () => {
    if (submitting || optimisticAnswered) return
    const choices = [...new Set([...selected.values()].flatMap((g) => [...g]))]
    const trimmed = text.trim()
    if (choices.length === 0 && !trimmed) {
      setError('Pick an option or add a note before submitting.')
      return
    }
    setError(null)
    setSubmitting(true)
    setOptimisticAnswered(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/points/${pointId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(choices.length ? { choices } : {}),
          ...(trimmed ? { text: trimmed } : {}),
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `answer failed (${res.status})`)
      // The answer persists as a thread reply and arrives on the next run delta.
    } catch {
      setOptimisticAnswered(false)
      setError('Could not deliver your answer. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, optimisticAnswered, selected, text, runId, pointId])

  const form: NoticeFormState = {
    interactive: true,
    answered: optimisticAnswered,
    submitting,
    selectedFor,
    text,
    toggleOption,
    setText,
    submit: submitAnswer,
  }

  return { form, error, answered: optimisticAnswered, setError }
}
