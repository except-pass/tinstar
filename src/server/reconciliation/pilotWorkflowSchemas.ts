import { z } from 'zod'
import { jiraPilotCardIdPattern, notionCardIdSchema } from '../../shared/workIdentity'
import { getWorkSchema, startWorkSchema, submitHandoffSchema, workflowUpdateSchema } from '../../shared/workflow'

const pilotCardIdSchema = z.string().regex(jiraPilotCardIdPattern)
export const pilotWorkflowCardIdSchema = z.union([notionCardIdSchema, pilotCardIdSchema])
export const pilotGetWorkSchema = getWorkSchema.extend({ card_id: pilotWorkflowCardIdSchema })
export const pilotStartWorkSchema = startWorkSchema.extend({ card_id: pilotWorkflowCardIdSchema })
export const pilotUpdateWorkSchema = workflowUpdateSchema(pilotWorkflowCardIdSchema)
const [exactTarget, externalTarget] = submitHandoffSchema.shape.target.options
export const pilotSubmitHandoffSchema = submitHandoffSchema.extend({
  target: z.union([exactTarget.extend({ card_id: pilotWorkflowCardIdSchema }),
    externalTarget.extend({ candidate_ids: z.array(pilotWorkflowCardIdSchema).max(20).default([]) })]),
})
