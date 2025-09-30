import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Conversation } from "../../../lib/conversation-schema";
import { parseJsonl } from "../parseJsonl";
import { decodeProjectId } from "../project/id";
import type { SessionDetail, SessionMeta } from "../types";
import { getWorktreeProjects } from "../worktree/utils";
import { getSessionMeta } from "../session/getSessionMeta";
import { getProjects } from "../project/getProjects";
import { getSessions } from "../session/getSessions";

interface CachedSession {
  conversations: (Conversation | { type: "x-error"; line: string })[];
  metadata: SessionMeta;
  filePosition: number;
  lastModified: Date;
  filePath: string;
}

interface CachedProject {
  sessions: Map<string, CachedSession>;
}

// Use globalThis to ensure singleton across Next.js hot reloads
const globalForSessionCache = globalThis as unknown as {
  sessionCacheInstance: SessionCacheService | undefined;
};

export class SessionCacheService {
  private cache: Map<string, CachedProject> = new Map();
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): SessionCacheService {
    if (!globalForSessionCache.sessionCacheInstance) {
      globalForSessionCache.sessionCacheInstance = new SessionCacheService();
    }
    return globalForSessionCache.sessionCacheInstance;
  }

  /**
   * Initialize cache by loading all sessions from all projects in parallel
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("SessionCacheService already initialized");
      return;
    }

    console.log("Initializing SessionCacheService...");
    const startTime = Date.now();

    try {
      const { projects } = await getProjects();
      console.log(`Found ${projects.length} projects to preload`);

      // Load all projects in parallel
      await Promise.all(
        projects.map((project) => this.preloadProject(project.id)),
      );

      this.isInitialized = true;
      const duration = Date.now() - startTime;
      const totalSessions = Array.from(this.cache.values()).reduce(
        (sum, project) => sum + project.sessions.size,
        0,
      );
      console.log(
        `SessionCacheService initialized in ${duration}ms - cached ${totalSessions} sessions`,
      );
    } catch (error) {
      console.error("Failed to initialize SessionCacheService:", error);
      throw error;
    }
  }

  /**
   * Preload all sessions for a specific project in parallel
   */
  private async preloadProject(projectId: string): Promise<void> {
    try {
      const sessions = await getSessions(projectId);
      console.log(
        `Preloading ${sessions.sessions.length} sessions for project ${projectId}`,
      );

      // Load all sessions in parallel
      const results = await Promise.allSettled(
        sessions.sessions.map((session) =>
          this.loadSession(projectId, session.id),
        ),
      );

      // Log any failures
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(
          `Failed to load ${failures.length} sessions for project ${projectId}`,
        );
      }
    } catch (error) {
      console.error(`Failed to preload project ${projectId}:`, error);
      // Don't throw - continue with other projects
    }
  }

  /**
   * Load a single session into cache
   */
  private async loadSession(
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const projectPath = decodeProjectId(projectId);
      let sessionPath = resolve(projectPath, `${sessionId}.jsonl`);
      let content: string | undefined;

      // Try main project directory first
      try {
        content = await readFile(sessionPath, "utf-8");
      } catch (error: unknown) {
        const nodeError = error as { code?: string };
        // If not found, search in worktree projects
        if (nodeError.code === "ENOENT") {
          const worktreeProjects = await getWorktreeProjects(projectPath);

          for (const worktreeProject of worktreeProjects) {
            const worktreeSessionPath = resolve(
              worktreeProject.claudeProjectPath,
              `${sessionId}.jsonl`,
            );
            try {
              content = await readFile(worktreeSessionPath, "utf-8");
              sessionPath = worktreeSessionPath;
              break;
            } catch {
              // Continue searching in other worktrees
            }
          }

          if (!content) {
            throw error; // Re-throw if not found anywhere
          }
        } else {
          throw error;
        }
      }

      // Parse conversations
      const conversations = parseJsonl(content);
      const stats = await stat(sessionPath);
      const metadata = await getSessionMeta(sessionPath);

      // Store in cache
      if (!this.cache.has(projectId)) {
        this.cache.set(projectId, { sessions: new Map() });
      }

      const project = this.cache.get(projectId);
      if (project) {
        project.sessions.set(sessionId, {
          conversations,
          metadata,
          filePosition: stats.size,
          lastModified: stats.mtime,
          filePath: sessionPath,
        });
      }
    } catch (error) {
      console.error(
        `Failed to load session ${projectId}/${sessionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Handle file change event - read only new content incrementally
   */
  public async handleFileChange(
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    const cached = this.cache.get(projectId)?.sessions.get(sessionId);

    if (!cached) {
      // Session not in cache yet - load it completely
      console.log(`Loading new session ${projectId}/${sessionId}`);
      await this.loadSession(projectId, sessionId);
      return;
    }

    try {
      // Check if file was actually modified
      const stats = await stat(cached.filePath);
      if (stats.mtime.getTime() === cached.lastModified.getTime()) {
        return; // No changes
      }

      // Read only new content from last position
      const fileHandle = await readFile(cached.filePath, "utf-8");
      const newContent = fileHandle.slice(cached.filePosition);

      if (newContent.trim().length === 0) {
        return; // No new content
      }

      // Parse new lines
      const newConversations = parseJsonl(newContent);

      // Append to existing conversations
      cached.conversations.push(...newConversations);
      cached.filePosition = stats.size;
      cached.lastModified = stats.mtime;

      // Update metadata
      cached.metadata = await getSessionMeta(cached.filePath);

      console.log(
        `Updated cache for ${projectId}/${sessionId} - added ${newConversations.length} new conversations`,
      );
    } catch (error) {
      console.error(
        `Failed to handle file change for ${projectId}/${sessionId}:`,
        error,
      );
      // On error, try to reload the entire session
      await this.loadSession(projectId, sessionId);
    }
  }

  /**
   * Get a cached session - returns synchronously from memory
   */
  public getSession(
    projectId: string,
    sessionId: string,
  ): SessionDetail | null {
    const project = this.cache.get(projectId);
    if (!project) {
      console.log(`[SessionCache] Project not found: ${projectId}`);
      console.log(`[SessionCache] Available projects:`, Array.from(this.cache.keys()));
      return null;
    }

    const cached = project.sessions.get(sessionId);
    if (!cached) {
      console.log(`[SessionCache] Session not found: ${sessionId} in project ${projectId}`);
      console.log(`[SessionCache] Available sessions in project:`, Array.from(project.sessions.keys()).slice(0, 5));
      return null;
    }

    return {
      id: sessionId,
      jsonlFilePath: cached.filePath,
      meta: cached.metadata,
      conversations: cached.conversations,
    };
  }

  /**
   * Check if cache is initialized
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get cache statistics
   */
  public getStats(): {
    projectCount: number;
    sessionCount: number;
    conversationCount: number;
  } {
    let sessionCount = 0;
    let conversationCount = 0;

    for (const project of this.cache.values()) {
      sessionCount += project.sessions.size;
      for (const session of project.sessions.values()) {
        conversationCount += session.conversations.length;
      }
    }

    return {
      projectCount: this.cache.size,
      sessionCount,
      conversationCount,
    };
  }
}