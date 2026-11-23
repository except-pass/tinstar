import { z } from 'zod'

const jiraSite = 'fortresspower-jira.atlassian.net'
const jiraWorkProject = '10639'
const jiraPilotProject = '10638'
export const jiraCardPrefix = `jira:${jiraSite}:${jiraWorkProject}:`
export const jiraPilotCardPrefix = `jira:${jiraSite}:${jiraPilotProject}:`

// Existing synthetic pilot IDs still identify their own source. The pilot
// adapter checks that exact project before using an issue ID.
const jiraIssueId = '[1-9][0-9]*'
const jiraCardId = jiraCardPrefix.replaceAll('.', '\\.') + jiraIssueId
const notionCardId = '[a-f0-9]{32}'
export const notionCardIdSchema = z.string().regex(new RegExp(`^${notionCardId}$`))
export const cardIdSchema = z.string().regex(new RegExp(`^(?:${notionCardId}|${jiraCardId})$`))
export const jiraCardIdPattern = new RegExp(`^${jiraCardId}$`)
export const isJiraPilotCard = (id: string) => id.startsWith(jiraPilotCardPrefix)
  && /^[1-9][0-9]*$/.test(id.slice(jiraPilotCardPrefix.length))
export const isJiraCard = (id: string) => jiraCardIdPattern.test(id) || isJiraPilotCard(id)

/** Exact source navigation without guessing a mutable Jira display key. */
export const cardSourceUrl = (id: string) => isJiraCard(id)
  ? `https://${jiraSite}/secure/IssueNavigator.jspa?jql=${encodeURIComponent(`id = ${id.split(':').at(-1)}`)}`
  : `https://www.notion.so/${id}`
