import type { Pin } from '@tinstar/plugin-api'

/** Mutators published by the host-mounted PinsBridge for the active space.
 *  Mirrors the events `getBridge()` pattern: api.pins.create/update/remove are
 *  NOT hooks, so they call through this module-level ref, which the
 *  <PinsBridge> component (mounted inside the active-space ConstellationProvider)
 *  keeps pointed at the live usePinSet mutators. */
export interface PinsBridgeMutators {
  create(pin: Pin): void
  update(id: string, fn: (p: Pin) => Pin): void
  remove(id: string): void
}

let mutators: PinsBridgeMutators | null = null

export function setPinsBridge(next: PinsBridgeMutators | null): void {
  mutators = next
}

export function getPinsBridge(): PinsBridgeMutators | null {
  return mutators
}
