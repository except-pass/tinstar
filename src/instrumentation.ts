export async function register() {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { SessionCacheService } = await import(
      "./server/service/cache/SessionCacheService"
    );
    const { getEventBus } = await import("./server/service/events/EventBus");
    const { getFileWatcher } = await import(
      "./server/service/events/fileWatcher"
    );

    console.log("Initializing server instrumentation...");

    // Get singleton instances
    const cacheService = SessionCacheService.getInstance();
    const fileWatcher = getFileWatcher();
    const eventBus = getEventBus();

    // Start file watcher
    fileWatcher.startWatching();
    console.log("File watcher started");

    // Connect cache service to file watcher events
    eventBus.on("file_changed_internal", (event) => {
      if (event.type === "file_changed_internal") {
        const { projectId, sessionId, fileEventType } = event.data;

        // Update cache first, then emit to SSE clients
        cacheService
          .handleFileChange(projectId, sessionId)
          .then(() => {
            // Cache updated - now notify clients
            eventBus.emit("project_changed", {
              type: "project_changed",
              data: {
                fileEventType,
                projectId,
              },
            });

            eventBus.emit("session_changed", {
              type: "session_changed",
              data: {
                projectId,
                sessionId,
                fileEventType,
              },
            });
          })
          .catch((error) => {
            console.error(
              `Failed to update cache for ${projectId}/${sessionId}:`,
              error,
            );
            // Still emit events so clients can try to fetch fresh data
            eventBus.emit("session_changed", {
              type: "session_changed",
              data: {
                projectId,
                sessionId,
                fileEventType,
              },
            });
          });
      }
    });
    console.log("Cache service connected to file watcher events");

    // Preload all sessions in parallel
    try {
      await cacheService.initialize();
      const stats = cacheService.getStats();
      console.log(
        `Session cache ready: ${stats.sessionCount} sessions, ${stats.conversationCount} conversations`,
      );
    } catch (error) {
      console.error("Failed to initialize session cache:", error);
      // Don't crash the server - cache will load on demand
    }

    console.log("Server instrumentation complete");
  }
}
