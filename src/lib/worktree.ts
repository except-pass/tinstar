/**
 * Client-side worktree utilities
 */

/**
 * Checks if a session is from a worktree based on its file path
 */
export const isWorktreeSession = (sessionFilePath: string): boolean => {
  return sessionFilePath.includes("-worktrees-");
};
