import { useEffect, useRef } from 'react'
import type { Pin } from '../domain/pinSet'

/** Auto-open the bubble for a just-dropped note so the user can type immediately
 *  (PinBubble autofocuses its textarea). Shared by the canvas PinLayer and the
 *  browser BrowserPinLayer so both surfaces behave identically.
 *
 *  A freshly dropped note is the only thing we want to pop open: unsent, no
 *  comment yet, and created moments ago. We guard against everything else that
 *  could look "new":
 *   - Pins already present on mount are seeded as handled, so a page with
 *     existing notes doesn't fling one open.
 *   - Pins that arrive later via hydration/SSE carry an old `createdAt`, so the
 *     recency check rejects them even though their ids are unseen.
 *   - Each id is opened at most once, so closing the bubble doesn't reopen it.
 */
export function useAutoOpenNewPin(pins: Pin[], open: (id: string) => void): void {
  const handled = useRef<Set<string>>(new Set())
  const seeded = useRef(false)

  useEffect(() => {
    const now = Date.now()
    if (!seeded.current) {
      // First run: treat whatever already exists as not-new.
      seeded.current = true
      for (const pin of pins) handled.current.add(pin.id)
      return
    }
    for (const pin of pins) {
      if (handled.current.has(pin.id)) continue
      handled.current.add(pin.id)
      const isFreshDrop = !pin.sentAt && !pin.comment && now - pin.createdAt < 5000
      if (isFreshDrop) open(pin.id)
    }
  }, [pins, open])
}
