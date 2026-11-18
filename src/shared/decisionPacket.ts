import { z } from 'zod'

const prose = z.string().trim().min(1).max(12000)
const option = z.object({ label: prose })
export const packetContents = z.object({
  summary: prose,
  options: z.array(option).min(1).max(30),
  recommendation: prose,
  links: z.array(z.object({ label: prose, url: z.string().url() })).max(30),
})
export type PacketContents = z.infer<typeof packetContents>
export type DecisionOption = PacketContents['options'][number] & { id: string }
export type DecisionPacket = Omit<PacketContents, 'options'> & {
  card_id: string
  source_revision: string
  title: string
  options: DecisionOption[]
}
