import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { claudeProjectPath } from "../paths";
import { getProjectMeta } from "../project/getProjectMeta";
import { encodeProjectId } from "../project/id";
import type { Project } from "../types";

/**
 * Checks if a project directory name indicates it's a worktree project
 * Matches pattern: {project-name}-worktrees-{uuid} or --{path}--{project}-worktrees-{uuid}
 */
export const isWorktreeProject = (projectDirName: string): boolean => {
  return projectDirName.includes("-worktrees-");
};

/**
 * Extracts the parent project path from a worktree project's Claude directory name
 * Returns the corresponding parent project path in ~/.claude/projects/
 */
export const findParentProjectPath = async (
  worktreeProjectPath: string,
): Promise<string | null> => {
  try {
    // Extract the directory name from the path
    const worktreeProjectDirName = worktreeProjectPath.split("/").pop();
    if (!worktreeProjectDirName || !isWorktreeProject(worktreeProjectDirName)) {
      return null;
    }

    // Extract parent project name from worktree directory name
    const parentProjectName = extractParentProjectNameFromWorktreePath(
      worktreeProjectDirName,
    );
    if (!parentProjectName) {
      return null;
    }

    // The parent project should exist in ~/.claude/projects/
    const parentProjectPath = resolve(claudeProjectPath, parentProjectName);

    // Verify it exists and is not itself a worktree
    try {
      const meta = await getProjectMeta(parentProjectPath);
      return meta ? parentProjectPath : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
};

/**
 * Checks if a session is from a worktree based on its file path
 */
export const isWorktreeSession = (sessionFilePath: string): boolean => {
  return sessionFilePath.includes("-worktrees-");
};

/**
 * Extracts the parent project name from a worktree directory name
 * Uses generic pattern matching that works on any machine/user:
 * - Mirrored: "-any-path--tinstar-worktrees--project-name-uuid" -> "-project-name"
 * - Old: "--home-ubuntu--tinstar-worktrees-uuid" -> "-home-ubuntu--tinstar"
 */
export const extractParentProjectNameFromWorktreePath = (
  worktreeProjectDirName: string,
): string | null => {
  // Check for mirrored pattern with tinstar-worktrees delimiter
  const delimiterIndex = worktreeProjectDirName.indexOf(
    "--tinstar-worktrees--",
  );
  if (delimiterIndex !== -1) {
    // Extract everything after the delimiter
    const afterDelimiter = worktreeProjectDirName.slice(
      delimiterIndex + "--tinstar-worktrees--".length,
    );

    // Remove trailing UUID (pattern: -{uuid} where uuid is alphanumeric)
    const withoutUuid = afterDelimiter.replace(/-[a-z0-9]+$/, "");

    // Add leading dash to match Claude project naming convention
    return withoutUuid ? `-${withoutUuid}` : null;
  }

  // Fallback to old pattern: {project-name}-worktrees-{uuid}
  const oldMatch = worktreeProjectDirName.match(/^(.+)-worktrees-[^-]+$/);
  return oldMatch?.[1] ?? null;
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

/**
 * Gets all worktree projects that belong to a parent project
 */
export const getWorktreeProjects = async (
  parentProjectPath: string,
): Promise<Project[]> => {
  try {
    // Extract the parent project directory name
    const parentProjectDirName = parentProjectPath.split("/").pop();
    if (!parentProjectDirName) {
      return [];
    }

    const dirents = await readdir(claudeProjectPath, { withFileTypes: true });
    const worktreeProjects: Project[] = [];

    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isWorktreeProject(dirent.name)) {
        continue;
      }

      // Extract parent project name from the worktree directory pattern
      const parentProjectName = extractParentProjectNameFromWorktreePath(
        dirent.name,
      );

      if (parentProjectName === parentProjectDirName) {
        const worktreePath = resolve(dirent.parentPath, dirent.name);
        const id = encodeProjectId(worktreePath);
        const worktreeMeta = await getProjectMeta(worktreePath);

        worktreeProjects.push({
          id,
          claudeProjectPath: worktreePath,
          meta: worktreeMeta,
        });
      }
    }

    return worktreeProjects;
  } catch {
    return [];
  }
};
