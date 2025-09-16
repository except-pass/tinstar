import type { SSEEvent } from "./types";

export const sseEventResponse = (event: SSEEvent) => {
  return {
    data: JSON.stringify(event),
    event: event.type,
    id: event.id,
  };
};
