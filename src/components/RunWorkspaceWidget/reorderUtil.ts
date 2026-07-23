// The index math behind the Slate's open-point reorder (S6 U2).
//
// Kept as a pure module on purpose. The reorder affordance is a grip handle plus
// ▲/▼ chevrons rather than pointer-drag — native HTML5 drag-and-drop is unreliable
// inside the zoom/pan-transformed canvas, and a drag is close to untestable there.
// The chevrons reduce the whole interaction to "move item i to i±1", which is this
// function, which a unit test can exercise directly.

/**
 * Return a NEW array with the item at `from` moved to `to`.
 *
 * Out-of-range indices (either end) return the input array unchanged, which is what
 * makes "move up from the top" and "move down from the bottom" quiet no-ops rather
 * than errors — the chevrons at the ends of the list simply do nothing.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [...items]
  if (from < 0 || from >= items.length) return [...items]
  if (to < 0 || to >= items.length) return [...items]
  if (from === to) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}
