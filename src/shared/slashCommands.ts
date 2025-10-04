export type CommandSource = "project" | "user" | "sdk";

export type CommandRecord = {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  tags?: string[];
  allowedTools?: string[];
  source?: CommandSource;
  path?: string;
  version?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type CommandsIndex = {
  byId: Record<string, CommandRecord>;
  order: string[];
  revision: number;
};

export type UserPrefs = {
  starred: string[];
  recent: string[];
};

export type SlashCommandData = {
  index: CommandsIndex;
  prefs: UserPrefs;
};

export const DEFAULT_USER_PREFS: UserPrefs = {
  starred: [],
  recent: [],
};
