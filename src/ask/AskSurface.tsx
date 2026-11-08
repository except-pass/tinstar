import { createElement, type HTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react'
import { askFieldSchema } from '../shared/ask'
import { useAskControls, useSemanticAsk } from './Ask'
import { useAskGesture } from './useAskGesture'
import type { AskSubject } from './semantic'

/** Row/block adapter for the same editable Ask gesture. Native controls and
 * horizontally scrollable table directions keep their normal interactions. */
export function AskSurface({ as = 'tr', subject, children, onKeyDown, ...props }: HTMLAttributes<HTMLElement> & { as?: 'tr' | 'section'; subject: AskSubject }) {
  const controls = useAskControls(), ask = useSemanticAsk(subject)
  const gesture = useAskGesture<HTMLElement>(controls ? () => controls.open(subject) : undefined, true)
  const semantic = (event: MouseEvent | KeyboardEvent) => {
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest('a,button,input,select,textarea')) return
    const field = element?.closest<HTMLElement>('[data-ask-field]')
    const key = askFieldSchema.safeParse(field?.dataset.askField)
    ask(event, key.success ? key.data : undefined, field?.textContent?.trim())
  }
  return createElement(as, { ...props, ref: gesture.ref, 'data-ask-hint': gesture.hint || undefined, onContextMenu: semantic,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { onKeyDown?.(event); if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) semantic(event) },
  }, children)
}
