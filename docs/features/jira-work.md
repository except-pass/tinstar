# Jira work through Tin Star MCP

Jira owns the ticket, its current status, and its history. Configure the same Tin Star MCP endpoint in ChatGPT and First Mate. The Jira credential stays in Tin Star. Humans can edit tickets in Jira. Keep GitHub PR URLs and First Mate execution references in the native description or comments.

## Jira provisioning

Start with an empty private team-managed project. Set its access in Jira and verify the intended membership before creating tickets. Confirm which default statuses belong to this project before preparing workflow payloads. [Jira space access](https://support.atlassian.com/jira-software-cloud/docs/manage-how-people-access-your-team-managed-project/) · [Team-managed REST privacy limitation](https://jira.atlassian.com/browse/JRACLOUD-83174)

Create missing project-owned statuses with `POST /rest/api/3/statuses` and explicit `PROJECT` scope. Confirm each status by ID and scope. Build a workflow from those project-owned definitions and validate it with `POST /rest/api/3/workflows/create/validation` before creating it. An update of a mixed-scope workflow can require shared status definitions in the mutable payload. Use a separate project-owned workflow in that case. [Jira Status API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-status/) · [Jira Workflows API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows/)

Use `POST /rest/api/3/workflowscheme/read` to find the existing scheme, confirm its project scope and exclusive usage, then use `POST /rest/api/3/workflowscheme/update/mappings` to get required issue-status migrations. Apply the new Task mapping through `POST /rest/api/3/workflowscheme/update`. Preserve the unrelated issue type mappings and use the scheme version from the read. A 303 response starts an asynchronous migration. Confirm the active mapping and the ticket's resulting native status before testing transitions. [Jira Workflow Schemes API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflow-schemes/)

## Private server configuration

Set `reconciliation.jira` in the server's private `TINSTAR_CONFIG_HOME/config.json`. Work mode replaces the [synthetic pilot](jira-adapter.md) for this server. Omitting `create_work.provider` still selects the existing Notion workflow. This example uses illustrative IDs. Copy IDs from the isolated Jira project and confirm them against Task create and edit metadata, and Epic metadata if Epic is configured.

```json
{
  "reconciliation": {
    "jira": {
      "mode": "work",
      "url": "https://example.atlassian.net",
      "cloudId": "5bac40b8-c168-4931-90d1-2c8dfe15c6ea",
      "projectId": "10001",
      "issueTypes": { "Task": "10100", "Epic": "10101" },
      "fields": {
        "owner": "customfield_11001",
        "decisions": "customfield_11002",
        "blockerType": "customfield_11003",
        "blockerTarget": "customfield_11004",
        "blockerCondition": "customfield_11005"
      },
      "blocksLinkTypeId": "10000"
    }
  }
}
```

Inject the scoped Jira service-account token as `TINSTAR_JIRA_TOKEN` through the service's secret mechanism. The adapter uses the Atlassian API gateway and a separate browser site URL. For the selected project, grant the service account Browse Projects, Create Issues, Edit Issues, Transition Issues, Link Issues, and Add Comments. Cross-project linking requires the corresponding permissions for the intended partners. Use the setup credential only for provisioning and revoke it after confirming access with the service credential. [Atlassian service-account tokens](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)

Owner is one Jira single select with approved names and no default. Decision Questions and Waiting For Condition are multiline fields. Waiting For Type is a single select with Actor and Event. Waiting For ID is a single-line field. For a Jira blocker, use one inward Blocks link from the blocked ticket. Jira's own project permissions and workflow rules apply to native UI edits.

## MCP calls

Tin Star requests English status names from Jira Cloud for transition matching and readback, regardless of the service account's language preference.

| Tool | Arguments and result |
| --- | --- |
| `create_work` | Set `provider: "jira"`, `name`, and `operation_id`. Task is the default. Optionally include `issue_type: "Epic"`, `description`, or `owner`. Jira must confirm Backlog on create readback. |
| `get_work` | Pass the returned immutable `card.id` as `card_id` for get, edit, transition, and link calls. The ID has the form `jira:<site hostname>:<project ID>:<issue ID>`. The result includes the display key, native fields and links. The default detailed read includes up to 50 recent comments. Set `details: false` to skip comments. |
| `update_work` | Use `kind: "jira_edit"` and the ticket ID. Edit `name`, `description`, or `owner`. Use `null` to clear description or owner where allowed. Send `add_questions` with `id`, `question` and optional `options`, or `answers` with `id` and `answer`. Set `blocker` with `type`, `target` and `unblocks_when`, clear it with `null`, or add a Jira comment with `note`. |
| `transition_work` | Supply `verb` and give `to` for verbs with several destinations. Supply `evidence` and `reason` where relevant. Use `disposition` only for Park, Cancel, and Stop and Requeue. Entry into Verify in Prod requires identical `required_revision` and `live_revision`. The [transition rules](../../src/server/reconciliation/jiraWorkRules.ts) define allowed routes and required evidence, reasons and dispositions. |
| `link_work` | Set `action: "add"` with `target_key`, native link type `type`, and `direction` as displayed on this ticket. Set `action: "remove"` with the native `link_id`. |

All writes use an `operation_id`. Retry with the same arguments and authenticated caller. The receipt records the operation ID, kind, dispatch state, and any definitive Jira write rejection or initial create readback contradiction. An identical retry returns a recorded failure unchanged. An undispatched retry re-evaluates preconditions and can send a write once they pass. A dispatched retry without a recorded failure only checks Jira. That check confirms the requested fields, destination status, link, or comment as they exist now, even if a different writer or an earlier comment accounts for the match, and does not reconstruct the original transition path. For transitions with an audit note, the initial call checks the destination even if the transition response is lost. Once Jira confirms the destination, the call posts the note once through the Jira comment endpoint. It reads the note directly by the returned comment ID when available. With no usable ID, it verifies the note against the recent comments seen just before the POST if that baseline was available. It then reads the destination again before reporting saved. A definitive audit comment rejection is recorded as a partial result. If a dispatched transition retry confirms the destination but finds no matching audit note in the recent comments, it reports the transition as saved and warns that the audit note may be missing. Create retries check the operation property in the configured project. If the requested state cannot be confirmed, the result is `unconfirmed`. Check Jira before using a new operation ID. Keep Tin Star's private config directory across restarts so it retains caller-scoped receipts. Authenticated Tin Star tunnel callers share read and write access to the configured Jira project. Cross-project issues are used only as link targets by key and are represented only by the key Jira returns. TSW is the owner's private project. Authenticated MCP callers inherit the service account's TSW visibility. They may receive restricted comment IDs, creation times and author account IDs. Restricted comment bodies are omitted.

A human can move a ticket between Tin Star’s pre-write project check and Jira applying the request. Restrict the service account’s write permissions to TSW to enforce the boundary at write time, while Tin Star reports an error if post-write readback finds the ticket in another project.

The main path is Backlog → To Do → Queued → In Progress. Review and release paths use Ready for Review, Waiting for Prod Release and Verify in Prod before Done. Fast-track goes directly to Queued. Complete Directly goes from In Progress to Done for verified work without remaining review or release. Decision and Waiting For pause active work. Answer Decision and Resolve Wait choose an explicit destination. Recovery verbs return work to To Do or Queued. Cancel records the reason and disposition for live work, Park returns work to Backlog, and Reopen returns a terminal ticket to To Do or Queued.

Decision Questions uses headings such as `D1 [Open]: Which option should we adopt?`. Options and answers follow on indented lines, for example `  Answer: Use the first option.` Change the heading to `[Answered]` when answering in Jira. MCP edits reread the field before applying targeted changes, preserve untouched ADF content, and leave field history in Jira. Jira has no conditional field write, so a native edit between the reread and the write can still race with the MCP edit. Before entering Queued, provide an owner, instructions and a clear success condition, with the primary blocker removed. Start rechecks instructions and blockers, including blockers staged before Block. Return a Queued ticket to To Do before clearing its instructions. Tin Star checks the declared evidence and Jira readback. Jira remains the place to inspect the underlying work and its history.

## Local smoke check

```sh
npx vitest run src/server/reconciliation/__tests__/jiraWork.test.ts --exclude='e2e/**' --minWorkers=1 --maxWorkers=2
```

This exercises the MCP catalog and Jira request/readback contract with a synthetic source. For live acceptance, start `events watch --source jira` in the standalone Event Publisher, write a proof ticket through Tin Star MCP, and edit that ticket directly in Jira. Inspect the resulting source deliveries, restart on the same journal, and replay from the previous sequence. The isolated API proof confirmed a native required-description validator on Queue. Confirm the actual Owner field validator and native UI behavior on the target project, then verify live webhook coverage there. [Atlassian workflow capabilities](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows/#api-rest-api-3-workflows-capabilities-get)

[Event Publisher setup and replay](../../event-publisher/README.md#receive-jira-ticket-changes)
