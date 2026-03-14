import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ProjectTask } from "../types";

const tasksDir = resolve(homedir(), ".tinstar", "tasks");

const tasksPathForProject = (projectId: string) => {
  return resolve(tasksDir, `${projectId}.json`);
};

const ensureStorage = async () => {
  await mkdir(tasksDir, { recursive: true });
};

export const listProjectTasks = async (projectId: string): Promise<ProjectTask[]> => {
  await ensureStorage();

  try {
    const raw = await readFile(tasksPathForProject(projectId), "utf-8");
    const parsed = JSON.parse(raw) as ProjectTask[];
    return parsed;
  } catch {
    return [];
  }
};

export const saveProjectTasks = async (
  projectId: string,
  tasks: ProjectTask[],
): Promise<void> => {
  await ensureStorage();
  await writeFile(tasksPathForProject(projectId), JSON.stringify(tasks, null, 2));
};
