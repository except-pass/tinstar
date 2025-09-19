import { homedir } from "node:os";
import { resolve } from "node:path";
import z from "zod";

const modelTypeSchema = z.enum(["default", "sonnet", "opus", "opusplan"]);

export const configSchema = z.object({
  hideNoUserMessageSession: z.boolean().optional().default(true),
  unifySameTitleSession: z.boolean().optional().default(true),
  sendKeys: z
    .array(z.enum(["enter", "shift", "ctrl", "cmd"]))
    .optional()
    .default(["ctrl", "cmd"]),
  defaultPlanMode: z.boolean().optional().default(true),
  worktreesPath: z
    .string()
    .optional()
    .default(resolve(homedir(), ".tinstar", "worktrees")),
  defaultModel: modelTypeSchema.optional().default("default"),
});

export type Config = z.infer<typeof configSchema>;
