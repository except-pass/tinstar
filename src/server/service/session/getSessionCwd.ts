import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseJsonl } from "../parseJsonl";
import { getProject } from "../project/getProject";
import { isWorktreeSession } from "../worktree/utils";
import { getSession } from "./getSession";

/**
 * Checks if a worktree session is orphaned (worktree directory no longer exists)
 */
export const isOrphanedWorktreeSession = async (
  sessionFilePath: string,
): Promise<boolean> => {
  if (!isWorktreeSession(sessionFilePath)) {
    return false;
  }

  try {
    const content = await readFile(sessionFilePath, "utf-8");
    const lines = content.split("\n");

    // Extract CWD from session
    for (const line of lines) {
      const conversation = parseJsonl(line).at(0);
      if (
        conversation === undefined ||
        conversation === null ||
        (conversation as any).type === "summary" ||
        (conversation as any).type === "x-error"
      ) {
        continue;
      }

      const cwd = (conversation as any).cwd as string | undefined;
      if (cwd && cwd.length > 0) {
        // Check if the worktree directory still exists
        try {
          await access(cwd);
          return false; // Directory exists, not orphaned
        } catch {
          return true; // Directory doesn't exist, orphaned
        }
      }
    }
  } catch {
    // Error reading session - treat as orphaned
    return true;
  }

  return false;
};

/**
 * Resolve the correct working directory for a given session.
 * - For regular sessions, returns the project cwd extracted from JSONL.
 * - For worktree sessions, returns the specific worktree path.
 * - Throws error if worktree session is orphaned.
 */
export const getSessionCwd = async (
  projectId: string,
  sessionId: string,
): Promise<string> => {
  const { session } = await getSession(projectId, sessionId);

  // Attempt to extract the recorded repo cwd from the session JSONL itself
  try {
    const content = await readFile(session.jsonlFilePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const conversation = parseJsonl(line).at(0);
      if (
        conversation === undefined ||
        conversation === null ||
        // Skip meta-only entries
        (conversation as any).type === "summary" ||
        (conversation as any).type === "x-error"
      ) {
        continue;
      }

      const cwd = (conversation as any).cwd as string | undefined;
      if (cwd && cwd.length > 0) {
        return cwd;
      }
    }
  } catch {
    // Ignore and fall through to fallbacks
  }

  // Fallbacks: prefer project meta path, then the directory containing the JSONL file
  try {
    const { project } = await getProject(projectId);
    if (project.meta.projectPath) {
      return project.meta.projectPath;
    }
  } catch {
    // ignore
  }

  return dirname(session.jsonlFilePath);
};
