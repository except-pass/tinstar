import { z } from 'zod'
import { releasePull } from './releases'

export const clawsonMergeSchema = z.object({
  operation_id: z.string().uuid(),
  targets: z.array(z.object({ url: z.string().url(), head: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict()).min(1).max(10),
}).strict()
export type ClawsonMergeInput = z.infer<typeof clawsonMergeSchema>
export interface ClawsonMergePlan { at: string; name: string; brief: string; script: string }


export function clawsonMergeTitle(input: ClawsonMergeInput): string {
  const repos = [...new Set(input.targets.map(target => {
    const pull = releasePull(target.url)
    if (!pull) throw new Error('Choose valid GitHub PR URLs.')
    return pull.repository
  }))]
  const title = `Admin merge ${input.targets.length} PR${input.targets.length === 1 ? '' : 's'}`
  const detailedTitle = `${title}: ${repos.join(', ')}`
  return detailedTitle.length <= 200 ? detailedTitle : `${title} across ${repos.length} repositories`
}
