import { z } from "zod";
import { UserMessageSchema } from "../message/UserMessageSchema";
import { BaseEntrySchema } from "./BaseEntrySchema";

export const UserEntrySchema = BaseEntrySchema.extend({
  // discriminator
  type: z.literal("user"),

  // optional - some user entries may not have a message (metadata entries)
  message: UserMessageSchema.optional(),

  // optional fields for special user entries
  isVisibleInTranscriptOnly: z.boolean().optional(),
});
