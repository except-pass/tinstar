import { createElement, type HTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react'
import { useAskControls, useSemanticAsk } from './Ask'
import { useElementAsk } from './useElementAsk'
import { useAskGesture } from './useAskGesture'
import type { AskSubject } from './semantic'

/** Row/block adapter for the same editable Ask gesture. Native controls and
 * horizontally scrollable table directions keep their normal interactions. */
export function AskSurface({ as = 'tr', subject, children, onKeyDown, onInspect, ...props }: HTMLAttributes<HTMLElement> & { as?: 'tr' | 'section' | 'article' | 'div'; subject: AskSubject; onInspect?: () => void }) {
  const controls = useAskControls(), ask = useSemanticAsk(subject)
  const gesture = useAskGesture<HTMLElement>(controls ? () => controls.open(subject) : undefined, true, onInspect)
  const affordance = useElementAsk(gesture.ref, subject, controls?.open)
  const semantic = (event: MouseEvent | KeyboardEvent) => {
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest('input,select,textarea') || element?.closest('a,button') && !element.closest('a[data-ask-field],button[data-ask-field]')) return
    ask(event)
  }
  return <>{createElement(as, { ...props, ref: gesture.ref, onContextMenu: semantic,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { onKeyDown?.(event); if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) semantic(event) },
  }, children)}{affordance}{gesture.overlay}</>
}
