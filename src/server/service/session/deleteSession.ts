import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { claudeProjectPath } from "../paths";

export interface DeleteSessionResult {
  success: boolean;
  message: string;
  recoveryPath?: string;
}

export async function deleteSession(
  projectId: string,
  sessionId: string,
): Promise<DeleteSessionResult> {
  const sessionFileName = `${sessionId}.jsonl`;
  const sourcePath = resolve(claudeProjectPath, projectId, sessionFileName);
  
  // Create .tinstar path - mirrors .claude structure
  const tinstarProjectPath = resolve(homedir(), ".tinstar", "projects");
  const targetDir = resolve(tinstarProjectPath, projectId);
  const targetPath = resolve(targetDir, sessionFileName);

  try {
    // Check if source file exists
    await stat(sourcePath);
  } catch (error) {
    return {
      success: false,
      message: `Session file not found: ${sessionFileName}`,
    };
  }

  try {
    // Create target directory if it doesn't exist
    await mkdir(targetDir, { recursive: true });

    // Move the file from .claude to .tinstar
    await rename(sourcePath, targetPath);

    return {
      success: true,
      message: `Session ${sessionId} moved to .tinstar folder. To restore, move the file back to .claude/projects/${projectId}/`,
      recoveryPath: targetPath,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}