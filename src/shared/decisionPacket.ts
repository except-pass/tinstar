import { z } from 'zod'

const prose = z.string().trim().min(1).max(12000)
export const decisionOptionEffects = z.object({
  status: prose.optional(),
  owner: prose.nullable().optional(),
  waiting_for: prose.nullable().optional(),
  waiting_for_type: z.enum(['Actor', 'Event', 'Work']).nullable().optional(),
  waiting_for_id: prose.nullable().optional(),
})
const option = z.object({ label: prose, next: decisionOptionEffects.optional() })
export const packetContents = z.object({
  summary: prose,
  options: z.array(option).min(1).max(30),
  recommendation: prose,
  links: z.array(z.object({ label: prose, url: z.string().url() })).max(30),
})
export type PacketContents = z.infer<typeof packetContents>
export type DecisionOptionEffects = z.infer<typeof decisionOptionEffects>
export type DecisionOption = PacketContents['options'][number] & { id: string }
export type DecisionPacket = Omit<PacketContents, 'options'> & {
  card_id: string
  source_revision: string
  title: string
  options: DecisionOption[]
}
