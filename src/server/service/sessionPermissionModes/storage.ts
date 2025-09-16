import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { PermissionMode } from "../claude-code/types";

interface SessionPermissionModes {
  [sessionId: string]: PermissionMode;
}

class SessionPermissionModeStorage {
  private storagePath: string;
  private modes: SessionPermissionModes = {};
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.storagePath = resolve(homedir(), ".tinstar", "session-modes.json");
    this.loadModes();
  }

  private async ensureDirectory() {
    const dir = resolve(homedir(), ".tinstar");
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // Directory already exists or other error we can ignore
    }
  }

  private async loadModes() {
    try {
      const data = await readFile(this.storagePath, "utf-8");
      this.modes = JSON.parse(data);
    } catch {
      // File doesn't exist or is invalid, start with empty modes
      this.modes = {};
    }
  }

  private async saveModes() {
    try {
      await this.ensureDirectory();
      await writeFile(this.storagePath, JSON.stringify(this.modes, null, 2));
    } catch (error) {
      console.error("Failed to save session permission modes:", error);
    }
  }

  private debouncedSave() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveModes();
      this.saveDebounceTimer = null;
    }, 1000);
  }

  public getMode(sessionId: string): PermissionMode | undefined {
    return this.modes[sessionId];
  }

  public setMode(sessionId: string, mode: PermissionMode) {
    this.modes[sessionId] = mode;
    this.debouncedSave();
  }

  public deleteMode(sessionId: string) {
    delete this.modes[sessionId];
    this.debouncedSave();
  }
}

// Singleton instance
export const sessionPermissionModeStorage = new SessionPermissionModeStorage();