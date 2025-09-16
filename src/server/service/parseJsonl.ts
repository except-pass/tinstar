import { ConversationSchema } from "../../lib/conversation-schema";
import type { ErrorJsonl } from "./types";

export const parseJsonl = (content: string) => {
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");

  return lines.map((line) => {
    let jsonData;
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
      console.warn(
        "Failed to parse jsonl, skipping. Entry type:",
        jsonData.type,
        "Error:",
        parsed.error.message,
      );
      console.warn(
        "Failed entry preview:",
        `${JSON.stringify(jsonData).slice(0, 200)}...`,
      );
      const errorData: ErrorJsonl = {
        type: "x-error",
        line,
      };
      return errorData;
    }

    return parsed.data;
  });
};
