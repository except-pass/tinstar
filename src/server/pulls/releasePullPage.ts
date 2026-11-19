import { z } from 'zod'
import { liveActionsEnabled, liveReaderJson } from '../actions/liveClient'
import { githubCliJson } from './github'
import { GithubResponseError } from './restBudget'

const timestamp = z.string().datetime({ offset: true })
const pullNumber = z.object({ number: z.number().int().positive().safe() })
const row = pullNumber.extend({
  title: z.string(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().nullish(),
  merged_at: timestamp.nullable(),
  closed_at: timestamp.nullish(),
  updated_at: timestamp,
  merge_commit_sha: z.string().nullable(),
  head: z.object({ sha: z.string().nullable() }),
  base: z.object({ ref: z.string().nullable() }),
})
export const releasePullPage = z.object({
  rows: z.array(row),
  count: z.number().int().nonnegative(),
  oldestUpdatedAt: timestamp.nullable(),
})

export function minimizeReleasePullPage(data: unknown, pullNumbers: number[]) {
  if (!Array.isArray(data)) throw new GithubResponseError()
  const wanted = new Set(pullNumbers)
  const rows = data.filter(item => {
    const identity = pullNumber.safeParse(item)
    return identity.success && wanted.has(identity.data.number)
  })
  const page = releasePullPage.safeParse({
    rows,
    count: data.length,
    oldestUpdatedAt: data.at(-1)?.updated_at ?? null,
  })
  if (!page.success) throw new GithubResponseError()
  return page.data
}

export function readReleasePullPage(path: string, pullNumbers: number[], onStart?: (startedAt: number, sequence?: number) => void): Promise<unknown> {
  if (liveActionsEnabled()) return liveReaderJson(path, '.', pullNumbers, onStart)
  const projection = `${JSON.stringify(pullNumbers)} as $wanted | {
    count:length, oldestUpdatedAt:.[-1].updated_at,
    rows:[.[] | .number as $number | select($wanted | index($number) != null)
      | {number,title,state,merged,merged_at,closed_at,updated_at,merge_commit_sha,head:{sha:.head.sha},base:{ref:.base.ref}}]
  }`
  return githubCliJson(path, projection, undefined, true, onStart)
}
