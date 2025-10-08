import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { type Config, configSchema } from "./config";

const CONFIG_FILENAME = "config.json";

class ConfigStorage {
  private readonly storagePath: string;
  private config: Config;
  private isLoaded = false;

  constructor() {
    this.storagePath = resolve(homedir(), ".tinstar", CONFIG_FILENAME);
    this.config = configSchema.parse({});
  }

  private async loadConfig(): Promise<void> {
    if (this.isLoaded) return;

    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Config> | undefined;
      if (parsed && typeof parsed === "object") {
        this.config = configSchema.parse(parsed);
      }
    } catch (_error) {
      // File doesn't exist or invalid JSON, use defaults
      this.config = configSchema.parse({});
    }

    this.isLoaded = true;
  }

  private async ensureDirectory(): Promise<void> {
    const dir = resolve(homedir(), ".tinstar");
    await mkdir(dir, { recursive: true });
  }

  private async persistConfig(): Promise<void> {
    await this.ensureDirectory();
    await writeFile(
      this.storagePath,
      JSON.stringify(this.config, null, 2),
      "utf8",
    );
  }

  public async getConfig(): Promise<Config> {
    await this.loadConfig();
    return this.config;
  }

  public async updateConfig(patch: Partial<Config>): Promise<Config> {
    await this.loadConfig();

    // Merge the patch with current config
    const merged = configSchema.parse({
      ...this.config,
      ...patch,
      // Special handling for nested objects
      commandPrefs: patch.commandPrefs
        ? {
            ...this.config.commandPrefs,
            ...patch.commandPrefs,
          }
        : this.config.commandPrefs,
    });

    this.config = merged;
    await this.persistConfig();
    return this.config;
  }

  public async replaceConfig(newConfig: Config): Promise<Config> {
    await this.loadConfig();
    this.config = configSchema.parse(newConfig);
    await this.persistConfig();
    return this.config;
  }

  public async updateCommandPrefs(
    patch: Partial<Config["commandPrefs"]>,
  ): Promise<Config> {
    await this.loadConfig();

    const updatedCommandPrefs = {
      ...this.config.commandPrefs,
      ...patch,
    };

    return this.updateConfig({ commandPrefs: updatedCommandPrefs });
  }

  public async touchRecentCommand(commandId: string): Promise<Config> {
    await this.loadConfig();

    const currentRecent = this.config.commandPrefs.recent;
    const updatedRecent = [
      commandId,
      ...currentRecent.filter((id) => id !== commandId),
    ].slice(0, 20); // Limit to 20 recent items

    return this.updateCommandPrefs({ recent: updatedRecent });
  }
}

let configStorageInstance: ConfigStorage | null = null;

export const getConfigStorage = (): ConfigStorage => {
  configStorageInstance ??= new ConfigStorage();
  return configStorageInstance;
};
