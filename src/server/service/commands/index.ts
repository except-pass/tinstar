import { ensureCommandLoaderReady, getCommandLoader } from "./CommandLoader";
import { getCommandPrefsStorage } from "./prefsStorage";
import type { SlashCommandData, UserPrefs } from "./types";

export const getSlashCommandData = async (): Promise<SlashCommandData> => {
  await ensureCommandLoaderReady();
  const loader = getCommandLoader();
  const prefsStorage = getCommandPrefsStorage();

  const [index, prefs] = await Promise.all([
    Promise.resolve(loader.getCommandsIndex()),
    prefsStorage.getPrefs(),
  ]);

  return {
    index,
    prefs,
  };
};

export const getCommandPrefs = async (): Promise<UserPrefs> => {
  const prefsStorage = getCommandPrefsStorage();
  return await prefsStorage.getPrefs();
};

export const updateCommandPrefs = async (
  patch: Partial<UserPrefs>,
): Promise<UserPrefs> => {
  const prefsStorage = getCommandPrefsStorage();
  return await prefsStorage.updatePrefs(patch);
};

export const forceReloadCommands = async () => {
  await ensureCommandLoaderReady();
  const loader = getCommandLoader();
  await loader.forceReload();
};
