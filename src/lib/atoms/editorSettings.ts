import { atomWithStorage } from "jotai/utils";

/**
 * Editor settings stored in localStorage
 */
export interface EditorSettings {
  /**
   * Command template for opening files/directories in an editor.
   * Use {{path}} as placeholder for the file/directory path.
   * If empty, falls back to $EDITOR env var, then "cursor {{path}}"
   */
  editorCommand: string;
}

const defaultSettings: EditorSettings = {
  editorCommand: "", // Empty means use system defaults
};

/**
 * Atom for editor settings with localStorage persistence
 */
export const editorSettingsAtom = atomWithStorage<EditorSettings>(
  "claude-code-viewer-editor-settings",
  defaultSettings,
);
