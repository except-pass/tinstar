import { getConfigStorage } from "../../config/storage";
import { ensureCommandLoaderReady, getCommandLoader } from "./CommandLoader";
import type { SlashCommandData, UserPrefs } from "./types";

export const getSlashCommandData = async (): Promise<SlashCommandData> => {
  await ensureCommandLoaderReady();
  const loader = getCommandLoader();
  const configStorage = getConfigStorage();

  const [index, config] = await Promise.all([
    Promise.resolve(loader.getCommandsIndex()),
    configStorage.getConfig(),
  ]);

  return {
    index,
    prefs: config.commandPrefs,
  };
};

export const getCommandPrefs = async (): Promise<UserPrefs> => {
  const configStorage = getConfigStorage();
  const config = await configStorage.getConfig();
  return config.commandPrefs;
};

export const updateCommandPrefs = async (
  patch: Partial<UserPrefs>,
): Promise<UserPrefs> => {
  const configStorage = getConfigStorage();
  const updatedConfig = await configStorage.updateCommandPrefs(patch);
  return updatedConfig.commandPrefs;
};

export const forceReloadCommands = async () => {
  await ensureCommandLoaderReady();
  const loader = getCommandLoader();
  await loader.forceReload();
};
