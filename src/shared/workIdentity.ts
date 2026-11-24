import { z } from 'zod'

// The first Jira slice is authorized only for this isolated project. Including
// site/project in the identity prevents routing an issue ID to another source.
export const jiraCardPrefix = 'jira:fortresspower-jira.atlassian.net:10638:'
export const cardIdSchema = z.string().regex(/^(?:[a-f0-9]{32}|jira:fortresspower-jira\.atlassian\.net:10638:[1-9][0-9]*)$/)
export const isJiraCard = (id: string) => id.startsWith(jiraCardPrefix) && cardIdSchema.safeParse(id).success

/** Exact source navigation without guessing a mutable Jira display key. */
export const cardSourceUrl = (id: string) => isJiraCard(id)
  ? `https://fortresspower-jira.atlassian.net/secure/IssueNavigator.jspa?jql=${encodeURIComponent(`id = ${id.slice(jiraCardPrefix.length)}`)}`
  : `https://www.notion.so/${id}`

const jiraIdentity = /^jira:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net):([1-9]\d*):([1-9]\d*)$/
export const jiraWorkIdentity = (id: string) => {
  const match = jiraIdentity.exec(id)
  return match ? { site: match[1]!, projectId: match[2]!, issueId: match[3]! } : undefined
}
export const jiraWorkIdSchema = z.string().regex(jiraIdentity, 'Use an exact Jira card ID')
