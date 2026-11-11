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
