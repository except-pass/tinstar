import { stat } from "node:fs/promises";
import type { SessionDetail } from "../types";

interface CacheEntry {
  sessionDetail: SessionDetail;
  fileMtime: number; // File modification time for cache invalidation
  lastAccessed: number; // For LRU eviction
}

/**
 * LRU cache for parsed session data
 * Caches both the parsed sessions and their file modification times for invalidation
 */
export class SessionCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Generate cache key from project and session IDs
   */
  private getCacheKey(projectId: string, sessionId: string): string {
    return `${projectId}:${sessionId}`;
  }

  /**
   * Check if cached entry is still valid by comparing file modification time
   */
  private async isValidCacheEntry(
    entry: CacheEntry,
    filePath: string,
  ): Promise<boolean> {
    try {
      const stats = await stat(filePath);
      const currentMtime = stats.mtime.getTime();
      return entry.fileMtime === currentMtime;
    } catch {
      // File doesn't exist or error accessing it
      return false;
    }
  }

  /**
   * Remove least recently used entries to maintain max size
   */
  private evictLRU(): void {
    if (this.cache.size <= this.maxSize) return;

    // Find the least recently accessed entry
    let oldestKey: string | null = null;
    let oldestTime = Number.MAX_SAFE_INTEGER;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      console.log(`[SessionCache] Evicted LRU entry: ${oldestKey}`);
    }
  }

  /**
   * Get cached session if valid, otherwise return null
   */
  async get(
    projectId: string,
    sessionId: string,
    filePath: string,
  ): Promise<SessionDetail | null> {
    const cacheKey = this.getCacheKey(projectId, sessionId);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      return null;
    }

    // Check if cache entry is still valid
    const isValid = await this.isValidCacheEntry(entry, filePath);
    if (!isValid) {
      this.cache.delete(cacheKey);
      console.log(`[SessionCache] Invalidated stale entry: ${cacheKey}`);
      return null;
    }

    // Update last accessed time for LRU
    entry.lastAccessed = Date.now();
    console.log(`[SessionCache] Cache HIT: ${cacheKey}`);
    return entry.sessionDetail;
  }

  /**
   * Store session in cache with current file modification time
   */
  async set(
    projectId: string,
    sessionId: string,
    filePath: string,
    sessionDetail: SessionDetail,
  ): Promise<void> {
    try {
      const stats = await stat(filePath);
      const cacheKey = this.getCacheKey(projectId, sessionId);

      const entry: CacheEntry = {
        sessionDetail,
        fileMtime: stats.mtime.getTime(),
        lastAccessed: Date.now(),
      };

      this.cache.set(cacheKey, entry);
      console.log(`[SessionCache] Cache MISS - Stored entry: ${cacheKey}`);

      // Maintain cache size
      this.evictLRU();
    } catch (error) {
      console.warn(
        `[SessionCache] Failed to cache session ${projectId}:${sessionId}`,
        error,
      );
    }
  }

  /**
   * Invalidate specific session from cache
   */
  invalidate(projectId: string, sessionId: string): void {
    const cacheKey = this.getCacheKey(projectId, sessionId);
    const deleted = this.cache.delete(cacheKey);
    if (deleted) {
      console.debug(`[SessionCache] Invalidated entry: ${cacheKey}`);
    }
  }

  /**
   * Invalidate all sessions for a project
   */
  invalidateProject(projectId: string): void {
    const prefix = `${projectId}:`;
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    if (keysToDelete.length > 0) {
      console.debug(
        `[SessionCache] Invalidated ${keysToDelete.length} entries for project: ${projectId}`,
      );
    }
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    console.debug(`[SessionCache] Cleared cache (${size} entries)`);
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    hitRate?: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * Check if a session is cached (without accessing it)
   */
  has(projectId: string, sessionId: string): boolean {
    const cacheKey = this.getCacheKey(projectId, sessionId);
    return this.cache.has(cacheKey);
  }
}

// Global singleton instance
let globalSessionCache: SessionCache | null = null;

/**
 * Get the global session cache instance
 */
export function getSessionCache(): SessionCache {
  if (!globalSessionCache) {
    globalSessionCache = new SessionCache(100); // Cache up to 100 sessions
  }
  return globalSessionCache;
}
