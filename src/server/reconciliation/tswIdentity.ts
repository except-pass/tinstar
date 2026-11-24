import type { WorkCard } from './workReader'

export const tswProjectId = '10639'
export const tswKey = (value: string) => /^TSW-[1-9]\d*$/.test(value) ? value : null

export function tswCardKey({ source }: WorkCard) {
  return source?.provider === 'jira' && !source.synthetic && source.collectionId === tswProjectId
    ? tswKey(source.displayKey) : null
}
