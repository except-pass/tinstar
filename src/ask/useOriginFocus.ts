import { useLayoutEffect, useRef } from 'react'
import type { AskReturn } from '../shared/ask'

export function findOriginElement(root: ParentNode | null, target: AskReturn['target']) {
  const selector = target.kind === 'receipt' ? '[data-receipt-id]' : target.kind === 'release' ? '[data-deployment-target]' : '[data-ask-origin]'
  return [...root?.querySelectorAll<HTMLElement>(selector) ?? []].find(row => target.kind === 'receipt' ? row.dataset.originPull === target.id && row.dataset.receiptId === target.receipt_id && row.dataset.component === target.component && row.dataset.target === target.target : target.kind === 'release' ? row.dataset.originPull === target.id && row.dataset.deploymentTarget === JSON.stringify([target.component, target.target]) : row.dataset.askOrigin === target.id)
}

/** Focus only an actual authorized row rendered by its section. A newer manual
 * route removes the locator, so delayed data cannot override that navigation. */
export function useOriginFocus(origin?: AskReturn) {
  const root = useRef<HTMLElement>(null), handled = useRef<AskReturn | null>(null)
  useLayoutEffect(() => {
    if (!origin) { handled.current = null; return }
    if (handled.current === origin) return
    const row = findOriginElement(root.current, origin.target)
    if (!row) return
    handled.current = origin
    row.scrollIntoView({ block: 'center', behavior: 'instant' }); row.focus({ preventScroll: true })
  })
  return root
}
