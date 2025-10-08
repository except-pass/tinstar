import type { WatchEventType } from "node:fs";

export type {
  CommandRecord,
  CommandSource,
  CommandsIndex,
  SlashCommandData,
  UserPrefs,
} from "@/shared/slashCommands";

export { DEFAULT_USER_PREFS } from "@/shared/slashCommands";

export type CommandWatchEvent = {
  type: "commands_changed";
  data: {
    revision: number;
    fileEventType: WatchEventType | "manual";
    source: "project" | "user" | "sdk" | "unknown";
  };
};
