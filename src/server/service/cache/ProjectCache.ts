import { stat } from "node:fs/promises";
import type { Project } from "../types";

interface ProjectCacheEntry {
  project: Project;
  dirMtime: number; // Directory modification time for cache invalidation
  lastAccessed: number; // For LRU eviction
}

/**
 * LRU cache for parsed project data
 * Caches project metadata which is expensive to compute (directory listing + file parsing)
 */
export class ProjectCache {
  private cache = new Map<string, ProjectCacheEntry>();
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Check if cached entry is still valid by comparing directory modification time
   */
  private async isValidCacheEntry(
    entry: ProjectCacheEntry,
    dirPath: string,
  ): Promise<boolean> {
    try {
      const stats = await stat(dirPath);
      const currentMtime = stats.mtime.getTime();
      return entry.dirMtime === currentMtime;
    } catch {
      // Directory doesn't exist or error accessing it
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
      console.log(`[ProjectCache] Evicted LRU entry: ${oldestKey}`);
    }
  }

  /**
   * Get cached project if valid, otherwise return null
   */
  async get(projectId: string, dirPath: string): Promise<Project | null> {
    const entry = this.cache.get(projectId);

    if (!entry) {
      return null;
    }

    // Check if cache entry is still valid
    const isValid = await this.isValidCacheEntry(entry, dirPath);
    if (!isValid) {
      this.cache.delete(projectId);
      console.log(`[ProjectCache] Invalidated stale entry: ${projectId}`);
      return null;
    }

    // Update last accessed time for LRU
    entry.lastAccessed = Date.now();
    console.log(`[ProjectCache] Cache HIT: ${projectId}`);
    return entry.project;
  }

  /**
   * Store project in cache with current directory modification time
   */
  async set(projectId: string, dirPath: string, project: Project): Promise<void> {
    try {
      const stats = await stat(dirPath);

      const entry: ProjectCacheEntry = {
        project,
        dirMtime: stats.mtime.getTime(),
        lastAccessed: Date.now(),
      };

      this.cache.set(projectId, entry);
      console.log(`[ProjectCache] Cache MISS - Stored entry: ${projectId}`);

      // Maintain cache size
      this.evictLRU();
    } catch (error) {
      console.warn(`[ProjectCache] Failed to cache project ${projectId}`, error);
    }
  }

  /**
   * Invalidate specific project from cache
   */
  invalidate(projectId: string): void {
    const deleted = this.cache.delete(projectId);
    if (deleted) {
      console.debug(`[ProjectCache] Invalidated entry: ${projectId}`);
    }
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    console.debug(`[ProjectCache] Cleared cache (${size} entries)`);
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * Check if a project is cached (without accessing it)
   */
  has(projectId: string): boolean {
    return this.cache.has(projectId);
  }
}

// Global singleton instance
let globalProjectCache: ProjectCache | null = null;

/**
 * Get the global project cache instance
 */
export function getProjectCache(): ProjectCache {
  if (!globalProjectCache) {
    globalProjectCache = new ProjectCache(50); // Cache up to 50 projects
  }
  return globalProjectCache;
}