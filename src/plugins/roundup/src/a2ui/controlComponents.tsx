// Host-rendered interactive controls (U2/U3) with host-managed form state (KTD2).
//
// The controls are A2UI component types the agent *declares* (parsed by the
// runtime-safe controls.ts); here we render them as Tinstar Tailwind form
// controls and read/write their value through a host-owned React context — NOT
// web_core's data model or its client-to-server action runtime, which stay
// deferred. When no interactive form context is present (a control rendered
// read-only, e.g. a headline preview), the default context renders the controls
// disabled/static so nothing is ever half-wired.
import { createContext, useContext, type ReactNode } from 'react'
import type { A2uiComponent } from '../../../../domain/types'
import { parseChoice } from './controls'

/** The host-owned form state for one notice. Held by the widget's NoticeCard
 *  (U3); the control components below read and mutate it through context. */
export interface NoticeFormState {
  /** False in a read-only render (no provider) → every control is disabled. */
  interactive: boolean
  /** The notice has been answered (optimistically or from the server). Controls
   *  lock and the submit shows a confirmation. */
  answered: boolean
  /** A submit is in flight — guards double-submit and shows a pending label. */
  submitting: boolean
  /** Selected option ids for ONE choice component, keyed by the choice's id. Each
   *  Choice group is independent, so two groups in a notice don't clobber each
   *  other (a single-select in one group doesn't wipe the other's selection). */
  selectedFor(choiceId: string): ReadonlySet<string>
  /** Current free-text value. */
  text: string
  toggleOption(choiceId: string, optionId: string, mode: 'single' | 'multi'): void
  setText(value: string): void
  submit(): void
}

/** The read-only default: no provider ⇒ controls render disabled and inert. */
const READ_ONLY_FORM: NoticeFormState = {
  interactive: false,
  answered: false,
  submitting: false,
  selectedFor: () => new Set(),
  text: '',
  toggleOption: () => {},
  setText: () => {},
  submit: () => {},
}

const NoticeFormContext = createContext<NoticeFormState>(READ_ONLY_FORM)

/** Provide the interactive form state to the controls rendered beneath it. */
export function NoticeFormProvider({ value, children }: { value: NoticeFormState; children: ReactNode }): ReactNode {
  return <NoticeFormContext.Provider value={value}>{children}</NoticeFormContext.Provider>
}

/** Read the current notice form state (the read-only default outside a provider). */
export function useNoticeForm(): NoticeFormState {
  return useContext(NoticeFormContext)
}

/** A malformed control degrades to this amber inline marker (never a throw),
 *  matching the walker's NodeFallback styling (R16/KTD4). */
function ControlFallback({ label }: { label: string }): ReactNode {
  return <span className="text-xs italic text-amber-300/80">⚠ {label}</span>
}

/** A single- or multi-select choice (R10). Radios for `single`, checkboxes for
 *  `multi`. Options and mode are agent-declared; the selection is host-owned. */
export function ChoiceControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const parsed = parseChoice(node)
  if (!parsed) return <ControlFallback label="choice has no options" />
  const disabled = !form.interactive || form.answered || form.submitting
  const multi = parsed.mode === 'multi'
  // The choice's own id keys its selection so multiple choice groups on one notice
  // stay independent. Radios also need a unique `name` per group to be mutually
  // exclusive within the group but not across groups.
  const choiceId = typeof node.id === 'string' && node.id ? node.id : ''
  const groupName = `choice-${choiceId || 'default'}`
  const selected = form.selectedFor(choiceId)
  return (
    <div className="flex flex-col gap-1 my-1.5" role={multi ? 'group' : 'radiogroup'}>
      {parsed.options.map(opt => (
        <label
          key={opt.id}
          className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-70' : 'cursor-pointer'}`}
        >
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={groupName}
            value={opt.id}
            checked={selected.has(opt.id)}
            disabled={disabled}
            onChange={() => form.toggleOption(choiceId, opt.id, parsed.mode)}
            className="mt-0.5 accent-amber-500"
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  )
}

/** A free-text field (R11), available with or without a choice set. */
export function TextInputControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const label = typeof node.label === 'string' ? node.label : ''
  const placeholder = typeof node.placeholder === 'string' ? node.placeholder : ''
  const disabled = !form.interactive || form.answered || form.submitting
  return (
    <div className="flex flex-col gap-1 my-1.5">
      {label && <span className="text-xs text-neutral-400">{label}</span>}
      <textarea
        rows={3}
        value={form.text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => form.setText(e.target.value)}
        className="w-full rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-500 focus:outline-none disabled:opacity-70"
      />
    </div>
  )
}

/** The submit control. Once answered it flips to a confirmation (R23); the widget
 *  disables it while a submit is in flight to prevent a double-submit. */
export function SubmitControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const label = typeof node.label === 'string' && node.label.trim() ? node.label : 'Submit'
  if (form.answered) {
    return <div className="my-1.5 text-sm font-medium text-emerald-300">✓ Answered</div>
  }
  return (
    <button
      type="button"
      onClick={() => form.submit()}
      disabled={!form.interactive || form.submitting}
      className="my-1.5 self-start rounded bg-amber-500 px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {form.submitting ? 'Submitting…' : label}
    </button>
  )
}
