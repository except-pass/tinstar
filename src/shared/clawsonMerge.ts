import { z } from 'zod'

export const clawsonMergeSchema = z.object({
  operation_id: z.string().uuid(),
  targets: z.array(z.object({ url: z.string().url(), head: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict()).min(1).max(10),
}).strict()
export type ClawsonMergeInput = z.infer<typeof clawsonMergeSchema>
