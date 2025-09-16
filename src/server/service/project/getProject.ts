import { existsSync } from "node:fs";

import type { Project } from "../types";
import { getProjectMeta } from "./getProjectMeta";
import { decodeProjectId } from "./id";

export const getProject = async (
  projectId: string,
): Promise<{ project: Project }> => {
  const fullPath = decodeProjectId(projectId);
  if (!existsSync(fullPath)) {
    throw new Error("Project not found");
  }

  const meta = await getProjectMeta(fullPath);

  return {
    project: {
      id: projectId,
      claudeProjectPath: fullPath,
      meta,
    },
  };
};
