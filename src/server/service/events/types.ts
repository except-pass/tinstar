import type { WatchEventType } from "node:fs";
import type { SerializableAliveTask } from "../claude-code/types";

export type WatcherEvent =
  | {
      eventType: "project_changed";
      data: ProjectChangedData;
    }
  | {
      eventType: "session_changed";
      data: SessionChangedData;
    };

export type BaseSSEEvent = {
  id: string;
  timestamp: string;
};

export type SSEEvent = BaseSSEEvent &
  (
    | {
        type: "connected";
        message: string;
        timestamp: string;
      }
    | {
        type: "heartbeat";
        timestamp: string;
      }
    | {
        type: "project_changed";
        data: ProjectChangedData;
      }
    | {
        type: "session_changed";
        data: SessionChangedData;
      }
    | {
        type: "task_changed";
        data: SerializableAliveTask[];
      }
  );

export interface ProjectChangedData {
  projectId: string;
  fileEventType: WatchEventType;
}

export interface SessionChangedData {
  projectId: string;
  sessionId: string;
  fileEventType: WatchEventType;
}
