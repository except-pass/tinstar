/**
 * Utilities for detecting and filtering slash command messages sent via command palette
 */

/**
 * Detects if a message content is a slash command sent through the command palette.
 * These messages typically contain extensive context injection from Claude Code SDK.
 */
export const isSlashCommandMessage = (content: string): boolean => {
  const trimmed = content.trim();

  // Basic check: starts with slash
  if (!trimmed.startsWith("/")) {
    return false;
  }

  // Additional heuristics to distinguish command palette messages from manual slash commands:
  // 1. Length check - context-injected messages are much longer
  if (content.length > 200) {
    return true;
  }

  // 2. Look for typical context injection patterns
  const hasContextPatterns = [
    "claudeMd",
    "CLAUDE.md",
    "system-reminder",
    "important-instruction-reminders",
    "Codebase and user instructions",
  ].some((pattern) => content.includes(pattern));

  if (hasContextPatterns) {
    return true;
  }

  // 3. Simple slash commands (likely manual) - single line starting with /
  const lines = content.split("\n");
  if (lines.length === 1 && lines[0] && lines[0].trim().startsWith("/")) {
    return false; // This is likely a manual command
  }

  // Default: if it starts with / and has multiple lines, likely command palette
  return lines.length > 1;
};

/**
 * Extracts the clean command line from a context-heavy slash command message.
 * Returns the original content if it can't parse a command.
 */
export const extractCleanCommand = (content: string): string => {
  const lines = content.split("\n");

  // Strategy 1: Find the first line that starts with /
  const commandLine = lines.find((line) => line.trim().startsWith("/"));
  if (commandLine) {
    return commandLine.trim();
  }

  // Strategy 2: Check if the first line is the command
  const firstLine = lines[0] ? lines[0].trim() : undefined;
  if (firstLine?.startsWith("/")) {
    return firstLine;
  }

  // Fallback: return original content
  return content.trim();
};

/**
 * Gets the command name from a command line (e.g., "/build" from "/build --watch")
 */
export const getCommandName = (commandLine: string): string => {
  const trimmed = commandLine.trim();
  if (!trimmed.startsWith("/")) {
    return "";
  }

  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return trimmed; // e.g., "/save"
  }

  return trimmed.slice(0, spaceIndex); // e.g., "/build" from "/build --watch"
};
