import { type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import z from "zod";
import { claudeProjectPath } from "../paths";
import { encodeProjectId } from "../project/id";
import { type EventBus, getEventBus } from "./EventBus";

const fileRegExp = /(?<projectId>.*?)\/(?<sessionId>.*?)\.jsonl/;
const fileRegExpGroupSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
});

export class FileWatcherService {
  private watcher: FSWatcher | null = null;
  private projectWatchers: Map<string, FSWatcher> = new Map();
  private eventBus: EventBus;

  constructor() {
    this.eventBus = getEventBus();
  }

  public startWatching(): void {
    try {
      console.log("Starting file watcher on:", claudeProjectPath);
      // Monitor main project directory
      this.watcher = watch(
        claudeProjectPath,
        { persistent: false, recursive: true },
        (eventType, filename) => {
          if (!filename) return;

          const groups = fileRegExpGroupSchema.safeParse(
            filename.match(fileRegExp)?.groups,
          );

          if (!groups.success) return;

          const { projectId: projectDirName, sessionId } = groups.data;

          // Convert directory name to full path and encode it as projectId
          const projectPath = resolve(claudeProjectPath, projectDirName);
          const projectId = encodeProjectId(projectPath);

          // Emit internal event - cache will handle and then emit to SSE clients
          this.eventBus.emit("file_changed_internal", {
            type: "file_changed_internal",
            data: {
              projectId,
              sessionId,
              fileEventType: eventType,
            },
          });
        },
      );
      console.log("File watcher initialization completed");
    } catch (error) {
      console.error("Failed to start file watching:", error);
    }
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const [, watcher] of this.projectWatchers) {
      watcher.close();
    }
    this.projectWatchers.clear();
  }
}

// Singleton instance
let watcherInstance: FileWatcherService | null = null;

export const getFileWatcher = (): FileWatcherService => {
  if (!watcherInstance) {
    console.log("Creating new FileWatcher instance");
    watcherInstance = new FileWatcherService();
  }
  return watcherInstance;
};
