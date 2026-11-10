import { z } from 'zod'
/** A request key is local to its home AND task; a hold id is local to its home. */
export interface FirstMateRequest {
  home: string
  taskId: string | null
  id: string | null
  kind: 'hold' | 'decision'
}
export const requestAnchor = (request: FirstMateRequest) => `desk-source:${JSON.stringify([request.home, request.taskId, request.kind, request.id])}`

export const firstMateRequestSchema = z.object({
  home: z.string().min(1).max(2048), taskId: z.string().min(1).max(1024).nullable(),
  id: z.string().min(1).max(1024), kind: z.enum(['hold', 'decision']),
}).strict()
