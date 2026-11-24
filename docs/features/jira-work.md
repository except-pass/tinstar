# Jira work through Tin Star MCP

Jira owns the ticket, its current status, and its history. Configure the same Tin Star MCP endpoint in ChatGPT and First Mate. The Jira credential stays in Tin Star. Humans can edit tickets in Jira. Keep GitHub PR URLs and First Mate execution references in the native description or comments.

## Jira provisioning

Start with an empty private team-managed project. Set its access in Jira and verify the intended membership before creating tickets. Confirm which default statuses belong to this project before preparing workflow payloads. [Jira space access](https://support.atlassian.com/jira-software-cloud/docs/manage-how-people-access-your-team-managed-project/) · [Team-managed REST privacy limitation](https://jira.atlassian.com/browse/JRACLOUD-83174)

Create missing project-owned statuses with `POST /rest/api/3/statuses` and explicit `PROJECT` scope. Confirm each status by ID and scope. Build a workflow from those project-owned definitions and validate it with `POST /rest/api/3/workflows/create/validation` before creating it. An update of a mixed-scope workflow can require shared status definitions in the mutable payload. Use a separate project-owned workflow in that case. [Jira Status API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-status/) · [Jira Workflows API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows/)

Use `POST /rest/api/3/workflowscheme/read` to find the existing scheme, confirm its project scope and exclusive usage, then use `POST /rest/api/3/workflowscheme/update/mappings` to get required issue-status migrations. Apply the new Task mapping through `POST /rest/api/3/workflowscheme/update`. Preserve the unrelated issue type mappings and use the scheme version from the read. A 303 response starts an asynchronous migration. Confirm the active mapping and the ticket's resulting native status before testing transitions. [Jira Workflow Schemes API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflow-schemes/)

## Private server configuration

Set `reconciliation.jira` in the server's private `TINSTAR_CONFIG_HOME/config.json`. Work mode replaces the [synthetic pilot](jira-adapter.md) for this server. Point the work-mode configuration at TSW. New board work uses that Jira project even when `create_work.provider` is omitted. This example uses illustrative IDs. Copy IDs from the isolated Jira project and confirm them against Task create and edit metadata, and Epic metadata if Epic is configured.

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

Inject the scoped Jira service-account token as `TINSTAR_JIRA_TOKEN` through the service's secret mechanism. The adapter uses the Atlassian API gateway and a separate browser site URL. For the selected project, grant the service account Browse Projects, Create Issues, Edit Issues, Transition Issues, Link Issues, Create Attachments, and Add Comments. Setting Assignee also requires Assign Issues and access to Jira’s assignable-user search. Cross-project linking requires the corresponding permissions for the intended partners. Use the setup credential only for provisioning and revoke it after confirming access with the service credential. [Atlassian service-account tokens](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)

Owner is one Jira single select with approved names and no default. Decision Questions and Waiting For Condition are multiline fields. Waiting For Type is a single select with Actor and Event. Waiting For ID is a single-line field. For a Jira blocker, use one inward Blocks link from the blocked ticket. Jira's own project permissions and workflow rules apply to native UI edits.

## MCP calls

Tin Star requests English status names from Jira Cloud for transition matching and readback, regardless of the service account's language preference.

| Tool | Arguments and result |
| --- | --- |
| `create_work` | Supply `name` and `operation_id`. If supplied, `provider` must be `"jira"`. Task is the default. Optionally include `issue_type: "Epic"`, `description`, or `owner`. Jira must confirm Backlog on create readback. |
| `get_work` | Pass the returned immutable `card.id` as `card_id` for get, edit, transition, and link calls. The ID has the form `jira:<site hostname>:<project ID>:<issue ID>`. The result includes the display key, native fields and links. The default detailed read includes up to 50 recent comments. Request `implementation_contract` to read verified chunks of an approved handoff. Set `details: false` to skip comments. |
| `submit_handoff` | Use a stable `target.external_ref` to create a Jira ticket or `target.card_id` for a known ticket. Tin Star saves and verifies the exact contract in Jira attachments before it queues a new ticket. Assignment and worker delivery are reported separately. |
| `update_work` | Use `kind: "jira_edit"` and the ticket ID. Edit `name`, `description`, `owner`, or `assignee`. Assignee must match the exact display name of one active, assignable Jira account. MCP readback exposes the display name and omits the account ID. Use `null` to clear description or Owner where allowed. Send `add_questions` with `id`, `question` and optional `options`, or `answers` with `id` and `answer`. Set `blocker` with `type`, `target` and `unblocks_when`, clear it with `null`, or add a Jira comment with `note`. |
| `transition_work` | Supply `verb` and give `to` for verbs with several destinations. Supply `evidence` and `reason` where relevant. Use `disposition` only for Park, Cancel, and Stop and Requeue. Entry into Verify in Prod requires identical `required_revision` and `live_revision`. The [transition rules](../../src/server/reconciliation/jiraWorkRules.ts) define allowed routes and required evidence, reasons and dispositions. |
| `link_work` | Set `action: "add"` with `target_key`, native link type `type`, and `direction` as displayed on this ticket. Set `action: "remove"` with the native `link_id`. |

All writes use an `operation_id`. Retry with the same arguments and authenticated caller. The receipt records the operation ID, kind, dispatch state, and any definitive Jira write rejection or initial create readback contradiction. An identical retry returns a recorded failure unchanged. An undispatched retry re-evaluates preconditions and can send a write once they pass. A dispatched retry without a recorded failure only checks Jira. That check confirms the requested fields, destination status, link, or comment as they exist now, even if a different writer or an earlier comment accounts for the match, and does not reconstruct the original transition path. Create retries check the operation property in the configured project. If the requested state cannot be confirmed, the result is `unconfirmed`. Check Jira before using a new operation ID. Keep Tin Star's private config directory across restarts so it retains caller-scoped receipts. Authenticated Tin Star tunnel callers share read and write access to the configured Jira project. Cross-project issues are used only as link targets by key and are represented only by the key Jira returns. TSW is the owner's private project. Authenticated MCP callers inherit the service account's TSW visibility. They may receive restricted comment IDs, creation times and author account IDs. Restricted comment bodies are omitted.

For transitions with an audit note, the initial call checks the destination after the transition request, including when the response is lost. Once Jira confirms the destination and Tin Star checks that the ticket still belongs to the configured project, the call posts the note once through the Jira comment endpoint. If Jira returns a usable comment ID, Tin Star reads that comment directly and verifies the ID, unrestricted visibility, text, and service-account author. If the response supplies no usable ID, including when it is lost, Tin Star compares up to 50 recent comments against the pre-POST snapshot and requires exactly one newly created, unedited match. If the snapshot is unavailable, the call can still post and confirm by returned ID. The initial call rereads the destination after confirming the note before reporting `saved`. A definitive audit comment rejection is recorded as `partially-saved` with code `unconfirmed`.

On a dispatched transition retry, if the destination matches but the recent comment page contains no matching audit note, Tin Star reports `saved` with a warning that the note may be missing.

A human can move a ticket between Tin Star’s pre-write project check and Jira applying the request. Restrict the service account’s write permissions to TSW to enforce the boundary at write time, while Tin Star reports an error if post-write readback finds the ticket in another project.

The main path is Backlog → To Do → Queued → In Progress. Review and release paths use Ready for Review, Waiting for Prod Release and Verify in Prod before Done. Fast-track goes directly to Queued. Complete Directly goes from In Progress to Done for verified work without remaining review or release. Decision and Waiting For pause active work. Answer Decision and Resolve Wait choose an explicit destination. Recovery verbs return work to To Do or Queued. Cancel records the reason and disposition for live work, Park returns work to Backlog, and Reopen returns a terminal ticket to To Do or Queued.

Decision Questions uses headings such as `D1 [Open]: Which option should we adopt?`. Options and answers follow on indented lines, for example `  Answer: Use the first option.` Change the heading to `[Answered]` when answering in Jira. MCP edits reread the field before applying targeted changes, preserve untouched ADF content, and leave field history in Jira. Jira has no conditional field write, so a native edit between the reread and the write can still race with the MCP edit. Before entering Queued, provide an owner, instructions and a clear success condition, with the primary blocker removed. Start rechecks instructions and blockers, including blockers staged before Block. Return a Queued ticket to To Do before clearing its instructions. Tin Star checks the declared evidence and Jira readback. Jira remains the place to inspect the underlying work and its history.

## First Mate status sync

The worker-link coordinator accepts fresh, complete snapshots from the configured files and uses fleet labels for Jira attribution. An exact `card: TSW-n` declaration binds the task to the issue. If the task and backlog copies name different TSW issues, both keys are excluded from event-driven writes. A plain move to In Progress requires affirmative current worker activity. On the way to Ready for Review or Done, the coordinator can pass through Start using the ready or merged pull request as evidence. With `yolo` off, Ready for Review requires the exact Jira assignee William Gathright and a merge note with the pull request URL. If the reviewer is unavailable, the audit records the blocked review. With `yolo` on, worker activity still governs whether the issue starts. Completion requires pull request evidence. When the same completion is present in the joined snapshot and later in the backlog alone, it keeps the same event ID after the worker disappears. Worker activity events include the spawn generation. The CI monitor detail `checks green: PR merged (ci monitor ended)` is recognized verbatim.

Configure Jira work mode for project 10639 on the coordinator's existing config root. In addition to the [Jira work permissions](#private-server-configuration), the coordinator’s service account needs access to TSW issue history. The adapter uses the shared Jira workflow and audits missing snapshots, skipped issues, and mutation readback. It preserves terminal statuses and existing blockers. Once the coordinator observes an intervening Jira Assignee change in history, it blocks review unless the issue is already assigned to the configured reviewer.

```sh
npm run --silent worker-links:adapter -- --config-home DIR --audit-file FILE --card TSW-1
```

Keep Jira status sync in report-only mode on the timer for the first day. The command above makes no Jira writes and reports card keys and reason codes such as `planned`. After that day, First Mate can enable Jira writes by adding `--apply --max-cards 1` to the explicit TSW card selection. Apply accepts an integer limit from 1 to 5. Keep the audit and its adjacent `.tsw-state.json` checkpoint across invocations and preserve the coordinator's Jira receipts in its config root. Each confirmed step records the Jira history position and includes its audit evidence in the private audit file. The coordinator moves forward from the current Jira status. The operation ID includes the current Jira status and its recorded history version. The checkpoint suppresses replay of recently applied events after an intervening owner move, including reopening a completed card. The coordinator reads back an uncertain dispatch and can retry an unapplied step once with a derived attempt ID. After a definitive rejection, a later pass can replan the step with a derived attempt ID. The coordinator audits each attempt and records `rejected-cap-reached` at the three-attempt step limit. When readback confirms a transition landed with a missing note, the coordinator can continue the workflow and queues the note for repair under the persisted operation ID. Each apply pass selects up to `--max-cards` eligible repair records, oldest first, using an allowance separate from forward writes. Repair checks for the original note before posting. Each dispatched repair POST counts toward the three-attempt cap, including an unconfirmed POST. A failure before dispatch leaves the attempt count unchanged. The audit records successful repair or abandonment. If the issue identity has changed, or the pre-POST check finds the issue Canceled, the repair is abandoned. Select only TSW keys with `--card` for a Jira-only invocation. An unfiltered `--apply` applies to Notion and reports Jira status reason codes. Run separate apply invocations for Notion and Jira. The adapter rejects `--apply` when `--card` includes both Notion page IDs and TSW keys.

Automated Decision and Waiting For routing are follow-ups. Production release routing needs a published deploy requirement. Automatic requeue needs a durable unlanded-cleanup disposition. Both routes await source evidence.

## Local smoke check

```sh
npx vitest run src/server/reconciliation/__tests__/jiraWork.test.ts --exclude='e2e/**' --minWorkers=1 --maxWorkers=2
```

This exercises the MCP catalog and Jira request/readback contract with a synthetic source. For live acceptance, start `events watch --source jira` in the standalone Event Publisher, write a proof ticket through Tin Star MCP, and edit that ticket directly in Jira. Inspect the resulting source deliveries, restart on the same journal, and replay from the previous sequence. The isolated API proof confirmed a native required-description validator on Queue. Confirm the actual Owner field validator and native UI behavior on the target project, then verify live webhook coverage there. [Atlassian workflow capabilities](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows/#api-rest-api-3-workflows-capabilities-get)

[Event Publisher setup and replay](../../event-publisher/README.md#receive-jira-ticket-changes)
