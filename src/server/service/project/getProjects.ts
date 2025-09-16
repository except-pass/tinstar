import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { claudeProjectPath } from "../paths";
import type { Project } from "../types";
import { isWorktreeProject } from "../worktree/utils";
import { getProjectMeta } from "./getProjectMeta";
import { encodeProjectId } from "./id";

export const getProjects = async (): Promise<{ projects: Project[] }> => {
  const dirents = await readdir(claudeProjectPath, { withFileTypes: true });
  const projects = await Promise.all(
    dirents
      .filter((d) => d.isDirectory() && !isWorktreeProject(d.name))
      .map(async (d) => {
        const fullPath = resolve(d.parentPath, d.name);
        const id = encodeProjectId(fullPath);

        return {
          id,
          claudeProjectPath: fullPath,
          meta: await getProjectMeta(fullPath),
        };
      }),
  );

  return {
    projects: projects.sort((a, b) => {
      return (
        (b.meta.lastModifiedAt?.getTime() ?? 0) -
        (a.meta.lastModifiedAt?.getTime() ?? 0)
      );
    }),
  };
};
