import type { GitResult } from "./types";
import { executeGitCommand } from "./utils";

export type GitCommitOptions = {
  message: string;
  allChanges?: boolean; // Add all changes before commit
  amend?: boolean; // Amend the last commit
};

export type GitCommitResult = {
  sha: string;
  message: string;
};

/**
 * Create a git commit with the specified message
 */
export async function commit(
  cwd: string,
  options: GitCommitOptions,
): Promise<GitResult<GitCommitResult>> {
  try {
    // Add all changes if requested
    if (options.allChanges) {
      const addResult = await executeGitCommand(["add", "."], cwd);
      if (!addResult.success) {
        return addResult;
      }
    }

    // Build commit command
    const commitArgs = ["commit"];

    if (options.amend) {
      commitArgs.push("--amend");
    }

    commitArgs.push("-m", options.message);

    const result = await executeGitCommand(commitArgs, cwd);

    if (!result.success) {
      return result;
    }

    // Get the commit hash and message
    const shaResult = await executeGitCommand(["rev-parse", "HEAD"], cwd);
    if (!shaResult.success) {
      return shaResult;
    }

    const sha = shaResult.data.trim();

    return {
      success: true,
      data: {
        sha,
        message: options.message,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "COMMAND_FAILED",
        message: `Failed to commit: ${error instanceof Error ? error.message : String(error)}`,
        command: `git commit -m "${options.message}"`,
      },
    };
  }
}

/**
 * Stage files for commit
 */
export async function addFiles(
  cwd: string,
  files: string[] = ["."],
): Promise<GitResult<void>> {
  const result = await executeGitCommand(["add", ...files], cwd);

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    data: undefined,
  };
}
