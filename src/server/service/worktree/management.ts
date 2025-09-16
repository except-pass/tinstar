import { exec } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { ulid } from "ulid";

const execAsync = promisify(exec);

/**
 * Ensures the worktrees directory exists
 */
export const ensureWorktreesDirectory = async (
  worktreesPath: string,
): Promise<void> => {
  await mkdir(worktreesPath, { recursive: true });
};

/**
 * Extracts the project directory name from the Claude project path
 * @param claudeProjectPath - Path like "/home/ubuntu/.claude/projects/-home-ubuntu-repo-tinstar"
 * @returns Project name like "-home-ubuntu-repo-tinstar"
 */
export const extractProjectName = (claudeProjectPath: string): string => {
  return basename(claudeProjectPath);
};

/**
 * Creates a new git worktree using mirrored directory structure and returns the worktree path
 * @param projectPath - The main project directory path (e.g., "/home/ubuntu/repo/tinstar")
 * @param claudeProjectPath - The Claude project path (e.g., "/home/ubuntu/.claude/projects/-home-ubuntu-repo-tinstar")
 * @param worktreesPath - The base directory where worktrees should be created
 * @returns The full path to the created worktree
 */
export const createWorktree = async (
  projectPath: string,
  claudeProjectPath: string,
  worktreesPath: string,
): Promise<string> => {
  // Extract project name from Claude project path
  const projectName = extractProjectName(claudeProjectPath);

  // Create mirrored directory structure: ~/.tinstar/worktrees/{PROJECT-NAME}/{UUID}
  const projectWorktreesPath = resolve(worktreesPath, projectName);
  await ensureWorktreesDirectory(projectWorktreesPath);

  // Generate unique worktree ID
  const worktreeId = ulid().toLowerCase();
  const worktreePath = resolve(projectWorktreesPath, worktreeId);

  try {
    // Get current branch from the project
    const { stdout: currentBranch } = await execAsync(
      "git branch --show-current",
      { cwd: projectPath },
    );

    const branchName = currentBranch.trim();
    if (!branchName) {
      throw new Error("Could not determine current branch");
    }

    // Create a new branch for the worktree
    const worktreeBranch = `worktree/${worktreeId}`;

    // Create the worktree with a new branch based on current branch
    await execAsync(
      `git worktree add -b "${worktreeBranch}" "${worktreePath}" "${branchName}"`,
      { cwd: projectPath },
    );

    return worktreePath;
  } catch (error) {
    throw new Error(
      `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Checks if a directory is a git repository
 */
export const isGitRepository = async (
  projectPath: string,
): Promise<boolean> => {
  try {
    await execAsync("git rev-parse --git-dir", { cwd: projectPath });
    return true;
  } catch {
    return false;
  }
};
