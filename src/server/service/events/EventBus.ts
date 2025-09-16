import { EventEmitter } from "node:events";

import type { BaseSSEEvent, SSEEvent } from "./types";

export class EventBus {
  private previousId = 0;
  private eventEmitter = new EventEmitter();

  public emit<
    T extends SSEEvent["type"],
    E = SSEEvent extends infer I ? (I extends { type: T } ? I : never) : never,
  >(type: T, event: Omit<E, "id" | "timestamp">): void {
    const base: BaseSSEEvent = {
      id: String(this.previousId++),
      timestamp: new Date().toISOString(),
    };

    this.eventEmitter.emit(type, {
      ...event,
      ...base,
    });
  }

  public on(
    event: SSEEvent["type"],
    listener: (event: SSEEvent) => void,
  ): void {
    this.eventEmitter.on(event, listener);
  }

  public off(
    event: SSEEvent["type"],
    listener: (event: SSEEvent) => void,
  ): void {
    this.eventEmitter.off(event, listener);
  }
}

// Singleton
let eventBusInstance: EventBus | null = null;

export const getEventBus = (): EventBus => {
  eventBusInstance ??= new EventBus();
  return eventBusInstance;
};
