/**
 * Client-side utilities for worktree operations
 */

/**
 * Checks if a session is from a worktree based on its file path
 */
export const isWorktreeSession = (sessionFilePath: string): boolean => {
  return sessionFilePath.includes("-worktrees-");
};

/**
 * Extracts the worktree UUID from a worktree session file path
 * Returns null if the session is not from a worktree
 */
export const extractWorktreeUuid = (sessionFilePath: string): string | null => {
  if (!isWorktreeSession(sessionFilePath)) {
    return null;
  }

  // Extract the project directory name from the path
  const pathParts = sessionFilePath.split("/");
  const projectDirName = pathParts.find((part) => part.includes("-worktrees-"));

  if (!projectDirName) {
    return null;
  }

  // Check for mirrored pattern with tinstar-worktrees delimiter
  const delimiterIndex = projectDirName.indexOf("--tinstar-worktrees--");
  if (delimiterIndex !== -1) {
    // Extract everything after the delimiter
    const afterDelimiter = projectDirName.slice(
      delimiterIndex + "--tinstar-worktrees--".length,
    );

    // Extract the UUID (last hyphen-separated segment)
    const uuidMatch = afterDelimiter.match(/-([a-z0-9]+)$/);
    return uuidMatch?.[1] ?? null;
  }

  // Fallback to old pattern: {project-name}-worktrees-{uuid}
  const oldMatch = projectDirName.match(/-worktrees-([a-z0-9]+)$/);
  return oldMatch?.[1] ?? null;
};
