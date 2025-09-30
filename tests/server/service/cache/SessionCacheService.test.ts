import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCacheService } from "@/server/service/cache/SessionCacheService";
import { encodeProjectId } from "@/server/service/project/id";

describe("SessionCacheService", () => {
  let cacheService: SessionCacheService;
  let testDir: string;
  let projectId: string;

  beforeEach(async () => {
    // Create isolated cache instance for each test
    cacheService = new (SessionCacheService as any)();

    // Create isolated temp directory for each test
    testDir = join(tmpdir(), `tinstar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    // Encode the temp directory as a project ID
    projectId = encodeProjectId(testDir);
  });

  afterEach(async () => {
    // Clean up temp directory after each test
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
      console.warn(`Failed to clean up test directory ${testDir}:`, error);
    }
  });

  it("should initialize empty cache", () => {
    expect(cacheService.isReady()).toBe(false);

    const stats = cacheService.getStats();
    expect(stats.projectCount).toBe(0);
    expect(stats.sessionCount).toBe(0);
    expect(stats.conversationCount).toBe(0);
  });

  it("should return null for non-existent session", () => {
    const result = cacheService.getSession(
      "nonexistent-project",
      "nonexistent-session",
    );
    expect(result).toBeNull();
  });

  it("should load and cache session from file", async () => {
    const sessionId = "test-session";
    const sessionFile = join(testDir, `${sessionId}.jsonl`);

    const initialConversations = [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "First message" }],
        },
        isSidechain: false,
        userType: "external",
        cwd: "/test/path",
        sessionId: "test-session",
        version: "1.0.0",
        uuid: "00000000-0000-4000-8000-000000000001",
        timestamp: "2025-01-01T00:00:00.000Z",
        parentUuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const initialContent = initialConversations
      .map((c) => JSON.stringify(c))
      .join("\n") + "\n";

    await writeFile(sessionFile, initialContent, "utf-8");

    // Load session into isolated cache
    await cacheService.loadSession(projectId, sessionId);

    // Verify session was loaded
    const session = cacheService.getSession(projectId, sessionId);
    expect(session).not.toBeNull();
    expect(session!.conversations.length).toBe(1);
    expect(session!.conversations[0].type).toBe("user");

    // Verify cache stats
    const stats = cacheService.getStats();
    expect(stats.projectCount).toBe(1);
    expect(stats.sessionCount).toBe(1);
    expect(stats.conversationCount).toBe(1);
  });

  it("should handle incremental updates to session files", async () => {
    const sessionId = "test-session";
    const sessionFile = join(testDir, `${sessionId}.jsonl`);

    const initialConversations = [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "First message" }],
        },
        isSidechain: false,
        userType: "external",
        cwd: "/test/path",
        sessionId: "test-session",
        version: "1.0.0",
        uuid: "00000000-0000-4000-8000-000000000001",
        timestamp: "2025-01-01T00:00:00.000Z",
        parentUuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const initialContent = initialConversations
      .map((c) => JSON.stringify(c))
      .join("\n") + "\n";

    await writeFile(sessionFile, initialContent, "utf-8");

    // Load session into isolated cache
    await cacheService.loadSession(projectId, sessionId);

    // Verify initial state
    const initialSession = cacheService.getSession(projectId, sessionId);
    expect(initialSession).not.toBeNull();
    expect(initialSession!.conversations.length).toBe(1);

    // Append a new conversation entry
    const newEntry = {
      type: "user",
      message: {
        role: "user",
        content: "Test message for incremental update",
      },
      isSidechain: false,
      userType: "external" as const,
      cwd: "/test/path",
      sessionId: "test-session",
      version: "1.0.0",
      uuid: "00000000-0000-4000-8000-000000000002",
      timestamp: new Date().toISOString(),
      parentUuid: "00000000-0000-4000-8000-000000000001",
    };

    await writeFile(
      sessionFile,
      initialContent + JSON.stringify(newEntry) + "\n",
      "utf-8",
    );

    // Wait to ensure file mtime updates
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Trigger incremental cache update
    await cacheService.handleFileChange(projectId, sessionId);

    // Verify the cache was updated incrementally
    const updatedSession = cacheService.getSession(projectId, sessionId);
    expect(updatedSession).not.toBeNull();
    expect(updatedSession!.conversations.length).toBe(2);

    // Verify the new message was added
    const testMessage = updatedSession!.conversations.find(
      (c) =>
        c.type === "user" &&
        "message" in c &&
        c.message &&
        typeof c.message.content === "string" &&
        c.message.content === "Test message for incremental update",
    );
    expect(testMessage).toBeDefined();
    expect(testMessage?.type).toBe("user");
    if (testMessage && "uuid" in testMessage) {
      expect(testMessage.uuid).toBe("00000000-0000-4000-8000-000000000002");
    }

    // Verify cache stats
    const stats = cacheService.getStats();
    expect(stats.projectCount).toBe(1);
    expect(stats.sessionCount).toBe(1);
    expect(stats.conversationCount).toBe(2);
  });
});