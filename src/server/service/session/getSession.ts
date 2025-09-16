import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJsonl } from "../parseJsonl";
import { decodeProjectId } from "../project/id";
import type { SessionDetail } from "../types";
import { getWorktreeProjects } from "../worktree/utils";
import { getSessionMeta } from "./getSessionMeta";

export const getSession = async (
  projectId: string,
  sessionId: string,
): Promise<{
  session: SessionDetail;
}> => {
  const projectPath = decodeProjectId(projectId);

  // Try to find the session file in the main project directory first
  let sessionPath = resolve(projectPath, `${sessionId}.jsonl`);
  let content: string | undefined;

  try {
    content = await readFile(sessionPath, "utf-8");
  } catch (error: any) {
    // If not found in main project, search in worktree projects
    if (error.code === "ENOENT") {
      const worktreeProjects = await getWorktreeProjects(projectPath);

      for (const worktreeProject of worktreeProjects) {
        const worktreeSessionPath = resolve(
          worktreeProject.claudeProjectPath,
          `${sessionId}.jsonl`,
        );
        try {
          content = await readFile(worktreeSessionPath, "utf-8");
          sessionPath = worktreeSessionPath;
          break;
        } catch {
          // Continue searching in other worktrees
        }
      }

      if (!content) {
        throw error; // Re-throw the original error if not found anywhere
      }
    } else {
      throw error; // Re-throw non-ENOENT errors
    }
  }

  const conversations = parseJsonl(content);

  const sessionDetail: SessionDetail = {
    id: sessionId,
    jsonlFilePath: sessionPath,
    meta: await getSessionMeta(sessionPath),
    conversations,
  };

  return {
    session: sessionDetail,
  };
};
