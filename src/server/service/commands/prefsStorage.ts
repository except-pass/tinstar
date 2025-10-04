import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { DEFAULT_USER_PREFS, type UserPrefs } from "./types";

const PREFS_FILENAME = "command-prefs.json";

class CommandPrefsStorage {
  private readonly storagePath: string;
  private prefs: UserPrefs = DEFAULT_USER_PREFS;
  private isLoaded = false;

  constructor() {
    this.storagePath = resolve(homedir(), ".tinstar", PREFS_FILENAME);
  }

  private async loadPrefs() {
    if (this.isLoaded) return;
    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<UserPrefs> | undefined;
      if (parsed && typeof parsed === "object") {
        this.prefs = this.normalisePrefs(parsed);
      }
    } catch (_error) {
      this.prefs = DEFAULT_USER_PREFS;
    }
    this.isLoaded = true;
  }

  private normalisePrefs(input: Partial<UserPrefs>): UserPrefs {
    const normaliseList = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return Array.from(
        new Set(
          value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        ),
      );
    };

    return {
      starred: normaliseList(input.starred),
      recent: normaliseList(input.recent).slice(0, 20),
    };
  }

  private async ensureDirectory() {
    const dir = resolve(homedir(), ".tinstar");
    await mkdir(dir, { recursive: true });
  }

  private async persistPrefs() {
    await this.ensureDirectory();
    await writeFile(
      this.storagePath,
      JSON.stringify(this.prefs, null, 2),
      "utf8",
    );
  }

  public async getPrefs(): Promise<UserPrefs> {
    await this.loadPrefs();
    return this.prefs;
  }

  public async replacePrefs(next: UserPrefs): Promise<UserPrefs> {
    await this.loadPrefs();
    this.prefs = this.normalisePrefs(next);
    await this.persistPrefs();
    return this.prefs;
  }

  public async updatePrefs(patch: Partial<UserPrefs>): Promise<UserPrefs> {
    const current = await this.getPrefs();
    const merged: UserPrefs = this.normalisePrefs({
      starred: patch.starred ?? current.starred,
      recent: patch.recent ?? current.recent,
    });
    this.prefs = merged;
    await this.persistPrefs();
    return merged;
  }

  public async touchRecent(commandId: string): Promise<UserPrefs> {
    const prefs = await this.getPrefs();
    const updatedRecent = [
      commandId,
      ...prefs.recent.filter((id) => id !== commandId),
    ];
    prefs.recent = updatedRecent.slice(0, 20);
    await this.persistPrefs();
    return this.prefs;
  }
}

let prefsStorageInstance: CommandPrefsStorage | null = null;

export const getCommandPrefsStorage = (): CommandPrefsStorage => {
  prefsStorageInstance ??= new CommandPrefsStorage();
  return prefsStorageInstance;
};
