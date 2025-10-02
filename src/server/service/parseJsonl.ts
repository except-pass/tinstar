import { ConversationSchema } from "../../lib/conversation-schema";
import type { ErrorJsonl } from "./types";

export const parseJsonl = (content: string) => {
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");

  return lines.map((line) => {
    const trimmed = line.trim();

    // Quick pre-check: JSONL conversation entries should be objects
    // This catches obviously malformed lines before trying to parse
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      console.warn(
        "Line doesn't look like a JSON object:",
        `${trimmed.slice(0, 100)}...`,
      );
      const errorData: ErrorJsonl = {
        type: "x-error",
        line: trimmed,
      };
      return errorData;
    }

    let jsonData: unknown;
    try {
      jsonData = JSON.parse(trimmed);
    } catch (_error) {
      console.warn(
        "Failed to parse JSON in line:",
        `${trimmed.slice(0, 100)}...`,
      );
      const errorData: ErrorJsonl = {
        type: "x-error",
        line: trimmed,
      };
      return errorData;
    }

    // Verify it's actually an object (not an array or primitive)
    if (
      typeof jsonData !== "object" ||
      jsonData === null ||
      Array.isArray(jsonData)
    ) {
      console.warn(
        "Parsed JSON is not an object:",
        `${trimmed.slice(0, 100)}...`,
      );
      const errorData: ErrorJsonl = {
        type: "x-error",
        line: trimmed,
      };
      return errorData;
    }

    const parsed = ConversationSchema.safeParse(jsonData);
    if (!parsed.success) {
      const entryType = (jsonData as { type?: unknown }).type;
      // Only log file-history-snapshot entries silently
      if (entryType !== "file-history-snapshot") {
        console.warn(`Failed to parse jsonl entry (type: ${entryType})`);
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
