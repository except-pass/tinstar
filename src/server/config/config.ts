import { homedir } from "node:os";
import { resolve } from "node:path";
import z from "zod";

export const configSchema = z.object({
  hideNoUserMessageSession: z.boolean().optional().default(true),
  unifySameTitleSession: z.boolean().optional().default(true),
  worktreesPath: z
    .string()
    .optional()
    .default(resolve(homedir(), ".tinstar", "worktrees")),
});

export type Config = z.infer<typeof configSchema>;
