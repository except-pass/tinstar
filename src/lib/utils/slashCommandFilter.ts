/**
 * Utilities for detecting and filtering slash command messages sent via command palette
 */

/**
 * Detects if a message content is a slash command.
 * This includes both command palette commands and manually typed slash commands.
 * All slash commands should be displayed with special formatting.
 */
export const isSlashCommandMessage = (content: string): boolean => {
  const trimmed = content.trim();

  // Basic check: starts with slash
  if (!trimmed.startsWith("/")) {
    return false;
  }

  // Any message starting with "/" is considered a command and should be formatted nicely
  // This includes:
  // - Simple commands from command palette (e.g., "/magic")
  // - Complex commands with context injection (longer messages)
  // - Manually typed slash commands
  return true;
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
