/** V5.1: spawn paths only carry context for `spawn: 'palette+context'`,
 *  which is reserved for V5.2+. For now always returns null.
 *
 *  Shipped now so plugin authors can compile against the V5.2 surface
 *  without an interface change later. */
export function useInitialContext<T>(): T | null {
  return null
}
