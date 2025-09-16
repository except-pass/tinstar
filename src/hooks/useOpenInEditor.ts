import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { editorSettingsAtom } from "@/lib/atoms/editorSettings";

export const useOpenInEditor = () => {
  const editorSettings = useAtomValue(editorSettingsAtom);

  const openInEditor = useCallback(
    async (path: string, overrideCommand?: string) => {
      try {
        const headers: HeadersInit = {
          "Content-Type": "application/json",
        };

        // Pass editor settings via header so backend can use it as fallback
        if (editorSettings.editorCommand) {
          headers["X-Editor-Settings"] = JSON.stringify(editorSettings);
        }

        const response = await fetch("/api/editor-open", {
          method: "POST",
          headers,
          body: JSON.stringify({
            path,
            command: overrideCommand,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          console.error("Failed to open in editor:", error);
          return { success: false, error };
        }

        const result = await response.json();
        return { success: true, ...result };
      } catch (error) {
        console.error("Error opening in editor:", error);
        return { success: false, error: String(error) };
      }
    },
    [editorSettings],
  );

  return { openInEditor };
};