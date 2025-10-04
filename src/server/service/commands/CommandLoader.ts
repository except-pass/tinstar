import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";

import { getEventBus } from "../events/EventBus";
import {
  extractFrontMatter,
  extractOrderHint,
  normalizeStringArray,
  resolveDescription,
} from "./parsing";
import type {
  CommandRecord,
  CommandSource,
  CommandsIndex,
  CommandWatchEvent,
} from "./types";

const MAX_FILE_BYTES = 64 * 1024; // 64KB limit to guard against runaway files

const projectCommandsRoot = resolve(process.cwd(), ".claude", "commands");
const userCommandsRoot = resolve(homedir(), ".claude", "commands");

type DraftCommandRecord = {
  record: Omit<CommandRecord, "id"> & { name: string; source: CommandSource };
  orderHint?: number;
  bodyContent: string;
};

type ReloadSource = CommandSource | "unknown";

const toUnixPath = (value: string) => value.replace(/\\/g, "/");

const sha256 = (value: string) => {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
};

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch (_error) {
    return null;
  }
}

const isWithinDirectory = async (
  root: string,
  candidate: string,
): Promise<boolean> => {
  const relativePath = relative(root, candidate);
  if (relativePath === "") {
    return true;
  }

  return (
    !relativePath.startsWith("..") &&
    !relativePath.includes("..\\") &&
    !relativePath.includes("../")
  );
};

const isSafeFile = async (filePath: string, root: string): Promise<boolean> => {
  if (!(await isWithinDirectory(root, filePath))) {
    return false;
  }

  const fileStat = await safeStat(filePath);
  if (!fileStat || !fileStat.isFile()) {
    return false;
  }

  const linkStat = await lstat(filePath);
  if (linkStat.isSymbolicLink()) {
    return false;
  }

  return fileStat.size <= MAX_FILE_BYTES;
};

export class CommandLoader {
  private index: CommandsIndex = { byId: {}, order: [], revision: 0 };
  private commandsById = new Map<string, CommandRecord>();
  private commandsByName = new Map<string, CommandRecord>();
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private isInitialized = false;
  private initializingPromise: Promise<void> | null = null;
  private readonly eventBus = getEventBus();

  public async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initializingPromise) {
      await this.initializingPromise;
      return;
    }

    this.initializingPromise = this.reload("manual", "unknown")
      .then(async () => {
        await this.setupWatchers();
        this.isInitialized = true;
      })
      .finally(() => {
        this.initializingPromise = null;
      });

    await this.initializingPromise;
  }

  public getCommandsIndex(): CommandsIndex {
    return this.index;
  }

  public getCommandById(commandId: string): CommandRecord | undefined {
    return this.commandsById.get(commandId);
  }

  public getCommandByName(name: string): CommandRecord | undefined {
    return this.commandsByName.get(name);
  }

  public async forceReload(): Promise<void> {
    await this.reload("manual", "unknown");
  }

  private async reload(
    fileEventType: CommandWatchEvent["data"]["fileEventType"],
    source: ReloadSource,
  ): Promise<void> {
    const drafts = await this.collectDraftRecords();

    const merged = new Map<string, DraftCommandRecord>();
    for (const draft of drafts) {
      merged.set(draft.record.name, draft);
    }

    const byId: Record<string, CommandRecord> = {};
    const orderable: Array<DraftCommandRecord & { id: string }> = [];

    for (const draft of merged.values()) {
      const versionMaterial = JSON.stringify({
        record: draft.record,
        body: draft.bodyContent,
      });
      const version = sha256(versionMaterial);
      const id = sha256(
        `${draft.record.source}:${draft.record.name}:${version}`,
      );
      const command: CommandRecord = {
        ...draft.record,
        id,
        version,
      };

      byId[id] = command;
      orderable.push({ ...draft, id });
    }

    const order = orderable
      .sort((a, b) => {
        if (
          typeof a.orderHint === "number" &&
          typeof b.orderHint === "number"
        ) {
          if (a.orderHint === b.orderHint) {
            return a.record.name.localeCompare(b.record.name);
          }
          return a.orderHint - b.orderHint;
        }
        if (typeof a.orderHint === "number") return -1;
        if (typeof b.orderHint === "number") return 1;
        return a.record.name.localeCompare(b.record.name);
      })
      .map((entry) => entry.id);

    const nextRevision = this.index.revision + 1;
    this.index = {
      byId,
      order,
      revision: nextRevision,
    };

    this.commandsById = new Map(order.map((id) => [id, byId[id]]));
    this.commandsByName = new Map(order.map((id) => [byId[id].name, byId[id]]));

    this.eventBus.emit("commands_changed", {
      type: "commands_changed",
      data: {
        revision: nextRevision,
        fileEventType,
        source,
      },
    });
  }

  private async collectDraftRecords(): Promise<DraftCommandRecord[]> {
    const drafts: DraftCommandRecord[] = [];

    const projectRecords = await this.collectCommandsFromRoot(
      projectCommandsRoot,
      "project",
    );
    drafts.push(...projectRecords);

    const userRecords = await this.collectCommandsFromRoot(
      userCommandsRoot,
      "user",
    );
    drafts.push(...userRecords);

    // SDK defaults could be provided here in the future

    return drafts;
  }

  private async collectCommandsFromRoot(
    root: string,
    source: CommandSource,
  ): Promise<DraftCommandRecord[]> {
    const rootStat = await safeStat(root);
    if (!rootStat || !rootStat.isDirectory()) {
      return [];
    }

    const records: DraftCommandRecord[] = [];

    const visit = async (currentDir: string) => {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(currentDir, entry.name);

        if (entry.isSymbolicLink()) {
          continue;
        }

        if (entry.isDirectory()) {
          await visit(entryPath);
          continue;
        }

        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
          continue;
        }

        if (!(await isSafeFile(entryPath, root))) {
          continue;
        }

        const parsed = await this.parseCommandFile(entryPath, root, source);
        if (parsed) {
          records.push(parsed);
        }
      }
    };

    await visit(root);

    return records;
  }

  private async parseCommandFile(
    filePath: string,
    root: string,
    source: CommandSource,
  ): Promise<DraftCommandRecord | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      const { frontMatter, body } = extractFrontMatter(raw);

      const relPath = toUnixPath(relative(root, filePath)).replace(
        /\.md$/i,
        "",
      );
      const name = `/${relPath}`;

      const description = resolveDescription(frontMatter, body);
      const aliases = normalizeStringArray(frontMatter.aliases);
      const tags = normalizeStringArray(frontMatter.tags);
      const allowedTools = normalizeStringArray(frontMatter.allowedTools);
      const orderHint = extractOrderHint(frontMatter);

      const fileStats = await stat(filePath);

      const record: Omit<CommandRecord, "id"> & {
        name: string;
        source: CommandSource;
        path: string;
        createdAt?: string;
        updatedAt?: string;
      } = {
        name,
        description,
        aliases,
        tags,
        allowedTools,
        source,
        path: filePath,
        createdAt: fileStats.birthtime.toISOString(),
        updatedAt: fileStats.mtime.toISOString(),
      };

      if (!description) {
        delete record.description;
      }

      if (!aliases) {
        delete record.aliases;
      }

      if (!tags) {
        delete record.tags;
      }

      if (!allowedTools) {
        delete record.allowedTools;
      }

      return { record, orderHint, bodyContent: body };
    } catch (error) {
      console.error("Failed to parse command file", filePath, error);
      return null;
    }
  }

  private async setupWatchers(): Promise<void> {
    await Promise.all([
      this.refreshWatchers(projectCommandsRoot, "project"),
      this.refreshWatchers(userCommandsRoot, "user"),
    ]);
  }

  private async refreshWatchers(root: string, source: CommandSource) {
    const rootStat = await safeStat(root);
    if (!rootStat || !rootStat.isDirectory()) {
      return;
    }

    const directories = await this.collectDirectories(root);
    directories.add(root);

    // Remove obsolete watchers
    for (const [watchedPath, watcher] of this.watchers.entries()) {
      if (!directories.has(watchedPath)) {
        watcher.close();
        this.watchers.delete(watchedPath);
      }
    }

    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;

      try {
        const watcher = watch(directory, { persistent: false }, (eventType) => {
          const timerKey = `${source}:${directory}`;
          if (this.debounceTimers.has(timerKey)) {
            clearTimeout(this.debounceTimers.get(timerKey));
          }

          const timer = setTimeout(() => {
            void this.refreshWatchers(root, source).catch((error) => {
              console.error("Failed to refresh command watchers", error);
            });
            this.reload(eventType, source).catch((error) => {
              console.error("Failed to reload commands", error);
            });
            this.debounceTimers.delete(timerKey);
          }, 150);

          this.debounceTimers.set(timerKey, timer);
        });

        watcher.on("error", (error) => {
          console.error("Command watcher error", directory, error);
        });

        this.watchers.set(directory, watcher);
      } catch (error) {
        console.error("Failed to watch directory", directory, error);
      }
    }
  }

  private async collectDirectories(root: string): Promise<Set<string>> {
    const directories = new Set<string>();

    const visit = async (directory: string) => {
      directories.add(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory() || entry.isSymbolicLink()) return;
          const entryPath = join(directory, entry.name);
          directories.add(entryPath);
          await visit(entryPath);
        }),
      ).catch((error) => {
        console.error("Failed to walk command directory", directory, error);
      });
    };

    await visit(root);
    return directories;
  }
}

let loaderInstance: CommandLoader | null = null;

export const getCommandLoader = (): CommandLoader => {
  loaderInstance ??= new CommandLoader();
  return loaderInstance;
};

export const ensureCommandLoaderReady = async () => {
  const loader = getCommandLoader();
  await loader.ensureInitialized();
};
