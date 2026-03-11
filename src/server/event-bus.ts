import { EventEmitter } from 'node:events'
import type { BusEvent, BusEventType } from './types'

type Handler<T extends BusEventType> = (event: Extract<BusEvent, { type: T }>) => void

export class EventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  emit(event: BusEvent): void {
    this.emitter.emit(event.type, event)
    this.emitter.emit('*', event)
  }

  on<T extends BusEventType>(type: T, handler: Handler<T>): void {
    this.emitter.on(type, handler as (...args: unknown[]) => void)
  }

  onAny(handler: (event: BusEvent) => void): void {
    this.emitter.on('*', handler)
  }

  off<T extends BusEventType>(type: T, handler: Handler<T>): void {
    this.emitter.off(type, handler as (...args: unknown[]) => void)
  }

  offAny(handler: (event: BusEvent) => void): void {
    this.emitter.off('*', handler)
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners()
  }
}
