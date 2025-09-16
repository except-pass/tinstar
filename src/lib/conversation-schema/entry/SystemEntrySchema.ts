import { z } from "zod";
import { BaseEntrySchema } from "./BaseEntrySchema";

export const SystemEntrySchema = BaseEntrySchema.extend({
  // discriminator
  type: z.literal("system"),

  // required
  content: z.string(),
  level: z.enum(["info", "warning", "error", "debug"]),

  // optional - some system entries may not have a toolUseID
  toolUseID: z.string().optional(),
});
