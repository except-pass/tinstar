import type { TriggerMatch, TriggerPlugin, TriggerContext } from "../types";

export class FileCompletionTrigger implements TriggerPlugin {
  readonly name = "file-completion";
  readonly triggers = ["@"];

  detect(input: string, cursorPosition: number): TriggerMatch | null {
    // Find the last "@" before the cursor
    const beforeCursor = input.substring(0, cursorPosition);
    const lastAtIndex = beforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) return null;

    // Check if there's any whitespace between @ and cursor
    const afterAt = beforeCursor.substring(lastAtIndex + 1);
    if (afterAt.includes(" ") || afterAt.includes("\n")) return null;

    return {
      type: "file-completion",
      trigger: "@",
      position: lastAtIndex,
      query: afterAt,
      fullMatch: `@${afterAt}`,
    };
  }

  onTrigger(match: TriggerMatch, context: TriggerContext): void {
    // File completion will be handled by the completion plugin
    // This trigger just detects the pattern
  }

  onDeactivate(): void {
    // File completion handles its own cleanup
  }
}