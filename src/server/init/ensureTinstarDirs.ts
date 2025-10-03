import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Ensures Tinstar runtime directories exist under the user's home directory.
 * Mirrors `mkdir -p ~/.tinstar/{projects,worktrees}`.
 */
export const ensureTinstarDirectories = async (): Promise<void> => {
  const basePath = resolve(homedir(), ".tinstar");
  const projectsPath = resolve(basePath, "projects");
  const worktreesPath = resolve(basePath, "worktrees");

  // Create base and subdirectories recursively; succeeds if already present
  await mkdir(basePath, { recursive: true });
  await mkdir(projectsPath, { recursive: true });
  await mkdir(worktreesPath, { recursive: true });
};
