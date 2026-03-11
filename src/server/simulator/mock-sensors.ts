import type { EventBus } from '../event-bus'
import { buildEventSequence } from './event-sequence'

export class MockSensorSimulator {
  private timers: ReturnType<typeof setTimeout>[] = []
  private running = false

  constructor(
    private bus: EventBus,
    private speedMultiplier = 1,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true

    const events = buildEventSequence()
    const instant = this.speedMultiplier === 0

    if (instant) {
      // Emit all events synchronously for test mode
      for (const { event } of events) {
        event.timestamp = new Date().toISOString()
        this.bus.emit(event)
      }
      this.running = false
      return
    }

    for (const { delayMs, event } of events) {
      const scaledDelay = delayMs / this.speedMultiplier
      const timer = setTimeout(() => {
        event.timestamp = new Date().toISOString()
        this.bus.emit(event)
      }, scaledDelay)
      this.timers.push(timer)
    }

    // Mark as done after the last event
    const lastDelay = events[events.length - 1]?.delayMs ?? 0
    const doneTimer = setTimeout(() => {
      this.running = false
    }, (lastDelay / this.speedMultiplier) + 100)
    this.timers.push(doneTimer)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }
}
