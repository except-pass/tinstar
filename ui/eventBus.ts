export type EventCallback = (data: any) => void;

class TinstarEventBus {
  private subscribers: Map<string, Set<EventCallback>> = new Map();
  private socket: WebSocket | null = null;

  subscribe(type: string, cb: EventCallback) {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    const set = this.subscribers.get(type)!;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  connect() {
    if (this.socket) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/events/ws`;
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.emit(msg.type, msg.data);
      } catch (e) {
        console.warn('Failed to parse message', e);
      }
    };
    this.socket.onclose = () => {
      this.socket = null;
    };
  }

  private emit(type: string, data: any) {
    const set = this.subscribers.get(type);
    if (!set) return;
    set.forEach(cb => cb(data));
  }
}

export const eventBus = new TinstarEventBus();
