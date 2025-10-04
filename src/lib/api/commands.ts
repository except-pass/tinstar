import type { SlashCommandData, UserPrefs } from "@/shared/slashCommands";
import { honoClient } from "./client";

export const fetchSlashCommands = async (
  forceReload?: boolean,
): Promise<SlashCommandData> => {
  const response = await honoClient.api.commands.$get({
    query: forceReload ? { forceReload: "1" } : undefined,
  });

  if (!response.ok) {
    throw new Error("Failed to load commands");
  }

  const data = (await response.json()) as SlashCommandData;
  return data;
};

export const patchCommandPrefs = async (
  patch: Partial<UserPrefs>,
): Promise<UserPrefs> => {
  const response = await honoClient.api.prefs.$patch({
    json: patch,
  });

  if (!response.ok) {
    throw new Error("Failed to update command prefs");
  }

  const body = (await response.json()) as { prefs: UserPrefs };
  return body.prefs;
};
