import { Children, cloneElement, isValidElement, createElement, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useAskControls, useSemanticAsk } from './Ask'
import { useElementAsk } from './useElementAsk'
import { useAskGesture } from './useAskGesture'
import { SwipeReveal } from './SwipeReveal'
import type { AskSubject } from './semantic'

/** Row/block adapter for the same editable Ask gesture. Native controls and
 * horizontally scrollable table directions keep their normal interactions. */
export function AskSurface({ as = 'tr', enabled = true, subject, children, onKeyDown, onInspect, ...props }: HTMLAttributes<HTMLElement> & { as?: 'tr' | 'section' | 'article' | 'div'; subject: AskSubject; onInspect?: () => void; enabled?: boolean }) {
  const controls = useAskControls(), ask = useSemanticAsk(subject)
  const gesture = useAskGesture<HTMLElement>(controls && enabled ? () => controls.open(subject) : undefined, true, enabled ? onInspect : undefined)
  const affordance = useElementAsk(gesture.ref, subject, enabled ? controls?.open : undefined)
  const semantic = (event: MouseEvent | KeyboardEvent) => {
    if (!enabled) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest('input,select,textarea') || element?.closest('a,button') && !element.closest('a[data-ask-field],button[data-ask-field]')) return
    ask(event)
  }
  // Keep native table markup and column sizing. Each cell clips its part of
  // the shared row gesture; only the exposed outer cell carries a label.
  const cells = Children.toArray(children)
  const content = as === 'tr' ? cells.map((cell, index) => isValidElement<{ children?: ReactNode }>(cell) ? cloneElement(cell, {},
    <SwipeReveal state={gesture.rail} labelSide={index === 0 ? 'inspect' : index === cells.length - 1 ? 'ask' : 'none'}>{cell.props.children}</SwipeReveal>) : cell)
    : <SwipeReveal state={gesture.rail}>{children}</SwipeReveal>
  return <>{createElement(as, { ...props, ref: gesture.ref, onContextMenu: semantic,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { onKeyDown?.(event); if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) semantic(event) },
  }, content)}{affordance}</>
}
