import type { PresentationDelivery } from '../shared/presentationObservation'

/** Inspect actual painted targets, including clipping and an open Desk overlay.
 * Never focus another browser tab. A fresh heartbeat alone proves no rendering. */
export function observeTargets(targets: string[], surface: 'overview' | 'decisions' | 'other'): PresentationDelivery {
  const foreground = document.visibilityState === 'visible' && document.hasFocus()
  const root = document.querySelector(surface === 'decisions' ? '.decisions' : '.ov')
  const nodes = [...root?.querySelectorAll<HTMLElement>('[data-semantic-id], .decisions-row[data-card-id]') ?? []]
  const rendered = targets.filter(id => nodes.some(node => node.dataset.semanticId === id || `card:${node.dataset.cardId}` === id))
  const visible = targets.filter(id => nodes.some(node => {
    if (node.dataset.semanticId !== id && `card:${node.dataset.cardId}` !== id) return false
    if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return false
    const rect = node.getBoundingClientRect()
    const x = Math.min(innerWidth - 1, rect.right - 1, Math.max(1, rect.left + rect.width / 2))
    const y = Math.min(innerHeight - 1, rect.bottom - 1, Math.max(1, rect.top + rect.height / 2))
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    return !!hit && (node === hit || node.contains(hit))
  }))
  const supported = targets.every(id => id.startsWith('card:') || id.startsWith('execution:'))
  const allVisible = visible.length === targets.length
  return {
    stage: !supported && !rendered.length ? 'not-supported' : !foreground ? 'not-visible' : allVisible ? 'foreground-visible' : rendered.length === targets.length ? 'rendered' : 'not-visible',
    reason: !supported && !rendered.length ? 'This surface has no rendered target for this action. Use card or execution targeting.' : !foreground ? 'Switch to this tab to see the pending focus.' : allVisible ? undefined : 'Target is missing, clipped, or covered; visual delivery is unconfirmed.',
    observed_at: new Date().toISOString(), surface, route: (location.pathname + location.search).slice(0, 2048),
    targets, rendered_targets: rendered, visible_targets: foreground ? visible : [], pending: supported && (!foreground || !allVisible),
  }
}
export function revealTargets(targets: string[], surface: 'overview' | 'decisions' | 'other') {
  const root = document.querySelector(surface === 'decisions' ? '.decisions' : '.ov')
  const node = [...root?.querySelectorAll<HTMLElement>('[data-semantic-id], .decisions-row[data-card-id]') ?? []].find(node => targets.includes(node.dataset.semanticId ?? `card:${node.dataset.cardId}`))
  node?.scrollIntoView({ block: 'center', behavior: 'instant' })
  node?.focus({ preventScroll: true })
}
