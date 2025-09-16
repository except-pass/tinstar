import { homedir } from "node:os";
import { resolve } from "node:path";

export const claudeProjectPath = resolve(homedir(), ".claude", "projects");
