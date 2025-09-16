import { readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { decodeProjectId } from "../project/id";
import type { Session } from "../types";
import { getWorktreeProjects } from "../worktree/utils";
import { getSessionMeta } from "./getSessionMeta";

const getTime = (date: string | null) => {
  if (date === null) return 0;
  return new Date(date).getTime();
};

export const getSessions = async (
  projectId: string,
): Promise<{ sessions: Session[] }> => {
  const claudeProjectPath = decodeProjectId(projectId);

  // Get sessions from the main project
  const dirents = await readdir(claudeProjectPath, { withFileTypes: true });
  const mainSessions = await Promise.all(
    dirents
      .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
      .map(async (d): Promise<Session> => {
        const fullPath = resolve(d.parentPath, d.name);

        return {
          id: basename(fullPath, extname(fullPath)),
          jsonlFilePath: fullPath,
          meta: await getSessionMeta(fullPath),
        };
      }),
  );

  // Get sessions from all associated worktree projects
  const worktreeProjects = await getWorktreeProjects(claudeProjectPath);
  const worktreeSessions: Session[] = [];

  for (const worktreeProject of worktreeProjects) {
    const worktreeDirents = await readdir(worktreeProject.claudeProjectPath, {
      withFileTypes: true,
    });

    const sessions = await Promise.all(
      worktreeDirents
        .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
        .map(async (d): Promise<Session> => {
          const fullPath = resolve(d.parentPath, d.name);

          return {
            id: basename(fullPath, extname(fullPath)),
            jsonlFilePath: fullPath,
            meta: await getSessionMeta(fullPath),
          };
        }),
    );

    worktreeSessions.push(...sessions);
  }

  // Combine main and worktree sessions, removing duplicates by session ID
  const sessionMap = new Map<string, Session>();

  // Add main sessions first
  for (const session of mainSessions) {
    sessionMap.set(session.id, session);
  }

  // Add worktree sessions (they will override if same ID exists)
  for (const session of worktreeSessions) {
    sessionMap.set(session.id, session);
  }

  const allSessions = Array.from(sessionMap.values());

  return {
    sessions: allSessions.sort((a, b) => {
      return getTime(b.meta.lastModifiedAt) - getTime(a.meta.lastModifiedAt);
    }),
  };
};
