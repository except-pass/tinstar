// The interactive-control model over the A2UI schema (KTD2, U2). Runtime-safe:
// no React, no browser globals — imported by the server bundle (esbuild, for the
// answer endpoint's server-side validation) as well as the client bundle (vite,
// for the control components in controls.tsx). This mirrors schema.ts's posture:
// the controls are A2UI *schema* component types the agent declares; only the
// rendering and submit are host-owned, and web_core's action runtime stays
// deferred (see docs/plans/2026-07-17-003-feat-roundup-interactivity-plan.md).
import type { A2uiComponent, A2uiContent } from '../domain/types'

/** The A2UI `component` type strings this slice adds as host-rendered controls.
 *  `Choice` carries a `mode` discriminator (single vs multi); `TextInput` is a
 *  free-text field; `Submit` submits the whole notice form once. */
export const CHOICE_COMPONENT = 'Choice'
export const TEXT_INPUT_COMPONENT = 'TextInput'
export const SUBMIT_COMPONENT = 'Submit'

/** The control component types, so the catalog and the walker can treat them as
 *  a set (they render only inside an interactive form context — U3). */
export const CONTROL_COMPONENTS: ReadonlySet<string> = new Set([
  CHOICE_COMPONENT,
  TEXT_INPUT_COMPONENT,
  SUBMIT_COMPONENT,
])

/** Free-text answers are capped so a hostile submit can't bloat the persisted
 *  notice snapshot (defense in depth alongside the API's own recheck, KTD4). */
export const NOTICE_ANSWER_TEXT_MAX = 4000

export interface ChoiceOption {
  id: string
  label: string
}

export interface ParsedChoice {
  /** `single` → radios (one selection); `multi` → checkboxes (any number). */
  mode: 'single' | 'multi'
  options: ChoiceOption[]
}

/** Parse a `Choice` node's agent-authored props into a validated option set, or
 *  `null` when it is malformed (wrong type, no valid options) so the renderer can
 *  degrade it (KTD4/R16) instead of throwing. Options with a non-string or empty
 *  `id`/`label` are dropped; a `Choice` with zero usable options parses to null. */
export function parseChoice(node: A2uiComponent): ParsedChoice | null {
  if (node.component !== CHOICE_COMPONENT) return null
  const raw = node.options
  if (!Array.isArray(raw)) return null
  const options: ChoiceOption[] = []
  for (const o of raw) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const { id, label } = o as { id?: unknown; label?: unknown }
      if (typeof id === 'string' && id !== '' && typeof label === 'string' && label !== '') {
        options.push({ id, label })
      }
    }
  }
  if (options.length === 0) return null
  const mode = node.mode === 'multi' ? 'multi' : 'single'
  return { mode, options }
}

/** True when the notice declares a free-text field the user can fill in (R11). */
export function hasTextInput(content: A2uiContent | undefined | null): boolean {
  return !!content
    && Array.isArray(content.components)
    && content.components.some(n => n?.component === TEXT_INPUT_COMPONENT)
}

/** True when the notice carries any interactive control (a choice, text field, or
 *  submit) — i.e. it is answerable from the widget rather than headline/prose only. */
export function isAnswerable(content: A2uiContent | undefined | null): boolean {
  return !!content
    && Array.isArray(content.components)
    && content.components.some(n => typeof n?.component === 'string' && CONTROL_COMPONENTS.has(n.component))
}

/** The universe of choice option ids a notice declares — the single source of
 *  truth the answer endpoint validates a submitted `choices[]` against (KTD4:
 *  a submitted id not in this set is rejected, nothing persisted). Scans the flat
 *  component list, which is a safe superset of what the walker renders. */
export function collectChoiceOptionIds(content: A2uiContent | undefined | null): Set<string> {
  const ids = new Set<string>()
  if (!content || !Array.isArray(content.components)) return ids
  for (const node of content.components) {
    const parsed = parseChoice(node)
    if (parsed) for (const o of parsed.options) ids.add(o.id)
  }
  return ids
}

/** option id → human label, so a delivered answer prompt can name the chosen
 *  option in words instead of an opaque id. Last declaration of an id wins. */
export function collectChoiceOptionLabels(content: A2uiContent | undefined | null): Map<string, string> {
  const labels = new Map<string, string>()
  if (!content || !Array.isArray(content.components)) return labels
  for (const node of content.components) {
    const parsed = parseChoice(node)
    if (parsed) for (const o of parsed.options) labels.set(o.id, o.label)
  }
  return labels
}
