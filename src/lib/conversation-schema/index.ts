import { z } from "zod";
import { AssistantEntrySchema } from "./entry/AssistantEntrySchema";
import { SummaryEntrySchema } from "./entry/SummaryEntrySchema";
import { SystemEntrySchema } from "./entry/SystemEntrySchema";
import { UserEntrySchema } from "./entry/UserEntrySchema";

export const ConversationSchema = z.union([
  UserEntrySchema,
  AssistantEntrySchema,
  SummaryEntrySchema,
  SystemEntrySchema,
]);

export type Conversation = z.infer<typeof ConversationSchema>;
