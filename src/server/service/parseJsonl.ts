import { ConversationSchema } from "../../lib/conversation-schema";
import type { ErrorJsonl } from "./types";

export const parseJsonl = (content: string) => {
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");

  return lines.map((line) => {
    let jsonData: unknown;
    try {
      jsonData = JSON.parse(line);
    } catch (_error) {
      console.warn("Failed to parse JSON in line:", `${line.slice(0, 100)}...`);
      const errorData: ErrorJsonl = {
        type: "x-error",
        line,
      };
      return errorData;
    }

    const parsed = ConversationSchema.safeParse(jsonData);
    if (!parsed.success) {
      const entryType = (jsonData as { type?: unknown }).type;
      // Only log file-history-snapshot entries silently
      if (entryType !== "file-history-snapshot") {
        console.warn(
          `Failed to parse jsonl entry (type: ${entryType})`
        );
      }
      const errorData: ErrorJsonl = {
        type: "x-error",
        line,
      };
      return errorData;
    }

    return parsed.data;
  });
};
