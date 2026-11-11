# Release acceptance (D.3)

Acceptance is required for every release-bound change. This slice records
contracts and execution evidence; the Notion writer remains OFF. Closure and
backfill remain later rollout steps. Optional editorial notes and
separate default-OFF publication are documented in [D.4 notes](releases-notes.md).

## Contract on existing work

Use a fenced `production-acceptance` JSON section in the card's existing
`Evidence` rich-text field (no new release or test database). Tin Star reads it through the normal
Notion card projection. Do not create properties or bulk-edit old cards as part
of activation. Missing/invalid contracts stay visible as unknown acceptance.

````text
```production-acceptance
{"checks":[{"id":"enum-mapping","successCondition":"Read-only fixture matches all six approved enum values without a customer device write.","method":"workflow","ref":"siteconfig.avalon-enum.prod","fixture":"approved-read-only-fixture"}]}
```
````

A check is a reference to an existing feature assertion, not a newly managed
test. Methods: `workflow`, `human`, `observation`. Human/observation checks also
require `owner` and use `ref` for the exact procedure or telemetry query.
Multiple checks are all required; a missing, skipped, failed or inconclusive
assertion cannot pass the change. Each explicitly linked card is evaluated
independently, even when several cards share a PR. All required PRs and exact
component targets must be proven in the selected release attempt.

## Operator configuration and activation

`$TINSTAR_CONFIG_HOME/releases/acceptance.json` follows the existing optional
versioned config pattern. Absent means OFF. No HTTP read or page click can
dispatch. This command is the explicit operator entry point; an existing scheduler
may invoke it after a separately authorized activation. There is no new daemon.

```json
{
  "version": 1,
  "enabled": false,
  "checks": {
    "siteconfig.avalon-enum.prod": {
      "repository": "fortresspower/cmsandbox",
      "workflow": "existing-smoke.yml",
      "ref": "main",
      "productionSafe": true,
      "inputs": {"fixture":"{fixture}","targets":"{targets}","receipts":"{receiptIds}"}
    }
  }
}
```

This is an illustrative mapping, not an assertion that `existing-smoke.yml`
exists. The owner must review the actual existing workflow, its feature-specific
assertions, read-only production fixture/targets and input names, and replace
this example with that mapping. `productionSafe: true` is the explicit approval
of that integration. The configured repository must match the selected release.
This boundary prevents a card from selecting arbitrary deploy/publish workflows
or injecting unreviewed inputs. Inputs are literal strings with optional
`{fixture}`, `{targets}`, `{receiptIds}`, `{sourceSha}`, `{releaseId}` replacements;
there is no shell interpolation. Review the workflow/ref again when its safety
or assertion semantics change. Workflow success must mean every required
feature assertion succeeded, with unsafe/missing assertions failing the workflow.

Owner prerequisites: current authoritative coordinator exports, complete exact
PR-to-card/target associations, an existing approved safe workflow and service
credentials for `gh-axi` with Actions read/write access to that repository.
Historical snapshots support review but cannot authorize dispatch or a new human
pass. A partial release may check its fully proven subset. Tag-only, skipped,
rolled-back, flagged, unknown or mismatched required targets hold the check.
The selected targets must still match current production repository/component/target,
source SHA and artifact identity. Every required PR must also have successful,
exception-free current target reconciliation and proven source ancestry; a newer
unsafe attempt holds the check even if its source and artifact are unchanged.
These gates apply to preview, dispatch/retry, collection/attachment and new manual
results. Historical release viewing and prior evidence remain available; an
audited skip can acknowledge a hold without claiming acceptance.

1. Keep `releases/automation.json` disabled. Do not activate the D.1 writer.
2. Configure the real safe-check mappings with `enabled: false`.
3. Run the zero-write preview and inspect each exact request and hold:

   ```sh
   PATH=/snap/node/current/bin:$PATH npx tsx scripts/releases-acceptance.ts --config-root "$TINSTAR_CONFIG_HOME"
   ```

4. **Owner-only, after separate activation approval:** set only `enabled` to
   `true` in `releases/acceptance.json`, then invoke:

   ```sh
   PATH=/snap/node/current/bin:$PATH npx tsx scripts/releases-acceptance.ts --config-root "$TINSTAR_CONFIG_HOME" --execute --actor OWNER_LOGIN
   ```

The same command collects exact run outcomes on subsequent invocations. Switch
back to `enabled: false` to stop dispatch and automatic collection; explicit
`attach`/`manual`/`skip` dispositions still work. No real workflow was dispatched
as part of implementing D.3.

GitHub's existing workflow_dispatch API returns the exact run ID/link using
`return_run_details: true`; see [GitHub's API contract](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
Only a completed `success` passes. Failure, running, missing, skipped,
inconclusive/cancelled/neutral remain distinct. Collection validates the workflow,
repository, event, ref and that the run began after target deployment.

## Evidence and supported recovery

Execution records use `workflow-create-receipts.json`, the existing Tin Star
workflow receipt store, under `release-acceptance:` keys. Contracts remain card
owned; deployments remain coordinator owned. There is no new release ledger.
Each record binds the exact release attempt, required merge identities, exact
target receipts, the check's assertion/reference/fixture and the approved resolved
workflow repository, workflow, ref and input values. Source ordering, JSON
formatting and observation timestamps do not affect that binding. Changes to
deployment identity, assertions or resolved execution values require fresh
evidence. GETs only read and expose records matching checks in the current
projected release scope; records outside that scope remain persisted unchanged.

Intent is saved before dispatch. A timeout/lost response stays inconclusive and
never automatically retries. Repeated runs collect the saved exact run rather
than guessing the newest run. History preserves failed results when an explicit
human exception or retry follows. Attachment can collect a result only when the
store already binds that exact run to this check's dispatch. A run without that
check-specific evidence remains inconclusive, even if its workflow/ref and timing
match; use an explicit manual result with evidence after inspection. The owner
can resolve a stuck check with one command and a reason; copy its exact `key` from the dry-run output:

```sh
# Attach a run; without a saved check-specific dispatch binding it stays inconclusive.
npx tsx scripts/releases-acceptance.ts --execute --actor OWNER_LOGIN --key 'CHECK_KEY' --action attach --run-id 12345 --reason 'Inspected the exact dispatch in GitHub'
# Explicit safe retry after checking that repeating the check is appropriate.
npx tsx scripts/releases-acceptance.ts --execute --actor OWNER_LOGIN --key 'CHECK_KEY' --action retry --reason 'Inspected prior run; approved another safe attempt'
# Human/observational result or an explicit manual exception to automation.
npx tsx scripts/releases-acceptance.ts --execute --actor REVIEWER_LOGIN --key 'CHECK_KEY' --action manual --outcome passed --reason 'Confirmed the specific production assertion' --evidence 'https://example.com/exact-observation'
# Acknowledge a blocked check without claiming success; later attach/manual/retry resumes it.
npx tsx scripts/releases-acceptance.ts --execute --actor OWNER_LOGIN --key 'CHECK_KEY' --action skip --reason 'Waiting for the named reviewer'
```

All mutation examples honor `TINSTAR_CONFIG_HOME`; `--config-root` can also select
an isolated root explicitly. Manual results require reason, actor, explicit
terminal outcome and evidence. They never infer success from delivery or from an
old failed check. A skipped check remains unaccepted. These dispositions do not
bypass deployment safety: a human pass still requires exact fresh target proof.
Failure routes remediation to the work owner in the drawer; it never causes a
rollback or a card-status mutation. The original failure remains in the visible
audit history.

Known inherited limitation: the D.1 opt-in closure policy still exists in the
legacy writer. Keep it OFF; D.5 must replace its completion predicate with
mandatory acceptance and coordinate policy changes before activation.
