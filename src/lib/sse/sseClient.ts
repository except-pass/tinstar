import type {
  ProjectChangedData,
  SessionChangedData,
} from "../../server/service/events/types";

export interface SSEEventHandlers {
  onProjectChanged?: (data: ProjectChangedData) => void;
  onSessionChanged?: (data: SessionChangedData) => void;
  onConnected?: () => void;
  onHeartbeat?: (timestamp: string) => void;
  onError?: (error: Event) => void;
  onClose?: () => void;
}

export class SSEClient {
  private eventSource: EventSource | null = null;
  private handlers: SSEEventHandlers;
  private url: string;

  constructor(baseUrl: string = "", handlers: SSEEventHandlers = {}) {
    this.url = `${baseUrl}/api/events`;
    this.handlers = handlers;
  }

  public connect(): void {
    if (this.eventSource) {
      this.disconnect();
    }

    try {
      this.eventSource = new EventSource(this.url);

      // 接続確認イベント
      this.eventSource.addEventListener("connected", (event) => {
        console.log("SSE Connected:", event.data);
        this.handlers.onConnected?.();
      });

      // プロジェクト変更イベント
      this.eventSource.addEventListener("project_changed", (event) => {
        try {
          const data: ProjectChangedData = JSON.parse(event.data);
          console.log("Project changed:", data);
          this.handlers.onProjectChanged?.(data);
        } catch (error) {
          console.error("Failed to parse project_changed event:", error);
        }
      });

      // セッション変更イベント
      this.eventSource.addEventListener("session_changed", (event) => {
        try {
          const data: SessionChangedData = JSON.parse(event.data);
          console.log("Session changed:", data);
          this.handlers.onSessionChanged?.(data);
        } catch (error) {
          console.error("Failed to parse session_changed event:", error);
        }
      });

      // ハートビートイベント
      this.eventSource.addEventListener("heartbeat", (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handlers.onHeartbeat?.(data.timestamp);
        } catch (error) {
          console.error("Failed to parse heartbeat event:", error);
        }
      });

      // エラーハンドリング
      this.eventSource.onerror = (error) => {
        console.error("SSE Error:", error);
        this.handlers.onError?.(error);
      };

      // 接続終了
      this.eventSource.onopen = () => {
        console.log("SSE Connection opened");
      };
    } catch (error) {
      console.error("Failed to establish SSE connection:", error);
      this.handlers.onError?.(error as Event);
    }
  }

  public disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      console.log("SSE Connection closed");
      this.handlers.onClose?.();
    }
  }

  public isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }
}

// React Hook example
export function useSSE(handlers: SSEEventHandlers) {
  const client = new SSEClient(window?.location?.origin, handlers);

  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    isConnected: () => client.isConnected(),
  };
}
