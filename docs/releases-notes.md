# Release notes (D.4)

Within a selected release, **Release notes** offers Internal / Customer and
**Copy draft**. Verify drafts include only explicitly linked work with complete
release membership, every required PR/target deployed and every D.3 acceptance
check passed with evidence. The accepted subset of a partial rollout can have
draft notes; unresolved work stays excluded. Plan notes are a planning preview,
never a deployment or acceptance claim. No page read or click publishes.

Internal view explains each Customer exclusion (internal-only work, unknown or
incomplete membership, unlinked work, undelivered targets, failed, running,
missing or otherwise unaccepted checks). Excluded material is outside the draft
and is never copied/published. Customer view omits that internal explanation.

## Editorial wording on existing work

Optional `notes` belong in the existing `production-acceptance` section in the
card's Evidence field; see [D.3 contracts](releases-acceptance.md). No new board
property/database or bulk backfill is needed:

````text
```production-acceptance
{
  "checks": [{"id":"generator-hz","successCondition":"The approved no-generator fixture has no Hz field.","method":"human","ref":"Open the approved read-only fixture and inspect Equipment.","owner":"Portal reviewer"}],
  "notes": {
    "audience":"customer",
    "internal":"Hide generator Hz when generator detection is absent.",
    "customer":"Generator frequency is no longer shown when a generator is not detected."
  }
}
```
````

Without `notes`, wording defaults to the work title and audience to Internal.
`audience: "customer"` explicitly permits Customer inclusion; Customer wording
falls back to Internal wording, then the title. An internal audience remains
excluded even when customer wording is supplied. Editorial edits preserve
acceptance evidence; changed assertions, required PRs or target receipts still
require matching D.3 evidence. Several PRs for one card produce one note; several
explicitly linked cards retain independent acceptance/wording.

## Separate publication command — default OFF

GitHub owns the human-readable published record. It never supplies deployment
proof. No publishing timer, HTTP write route, tag creation, deploy, merge or
Notion closure is added. Keep the D.1 writer OFF; D.5 policy/writer work remains
separate.

Absent `$TINSTAR_CONFIG_HOME/releases/publication.json` means OFF. Optional:

```json
{"version":1,"enabled":false}
```

Get the exact selected release ID from `/api/releases` (not its version label).
Preview is zero-write and does not call GitHub Releases, even when enabled:

```sh
PATH=/snap/node/current/bin:$PATH npx tsx scripts/releases-notes.ts \
  --config-root "$TINSTAR_CONFIG_HOME" --release-id 'EXACT_RELEASE_ID' --audience customer
```

The output includes exact repository/tag/source, included change IDs, body,
holds and the proposed `gh-axi release create ... --verify-tag --latest=false`
command. Review the body and audience. It contains accepted changes only, and
removes the draft status marker for the published record. Internal publication
is an explicit choice: it can expose engineering details on a public repository.

**Owner-only activation, after separate approval:** the owner/parent must first
review the repository's existing `release: published` listeners (Actions and
webhooks, including externally managed consumers) and confirm publishing will
not trigger unauthorized deployment or other privileged actions. This task
does not claim that review has occurred. Required access is `gh-axi` permission
to read the tag/release and create a release in that exact repository, plus the
configured coordinator/Notion read sources and matching D.3 acceptance records.

Then set only `enabled` to `true` in that root's
`releases/publication.json`, and explicitly invoke:

```sh
PATH=/snap/node/current/bin:$PATH npx tsx scripts/releases-notes.ts \
  --config-root "$TINSTAR_CONFIG_HOME" --release-id 'EXACT_RELEASE_ID' \
  --audience customer --execute --actor OWNER_LOGIN \
  --reason 'Owner approved publication after reviewing release:published listeners and this draft'
```

The command checks an existing lightweight/annotated tag's peeled commit
against the exact coordinator source and checks for an existing release before
creation. Creation always uses
[`--verify-tag`](https://cli.github.com/manual/gh_release_create), so a missing
tag cannot be implicitly created. No `--target`, generated-note API or assets
are supplied. A tag missing/mismatched to the selected release requires the
owner to correct/select authoritative evidence or create the intended tag
through the existing separately authorized release process, then rerun.

Existing published notes or drafts are returned with their URL, never silently
overwritten or published. Identical published content reports `already-published`.
A differing existing record reports `existing-release; review in GitHub`; a
draft reports `existing-draft; review in GitHub`. The owner can review/edit/close
that record through GitHub's existing audited workflow, then rerun this command
with a reason. These are supported dispositions, not a local stuck state.

## Audit, retry and disable

Each explicit operation records actor, reason, exact release/audience/body and
result under a `release-notes:` key in the existing
`workflow-create-receipts.json`. GitHub remains the release record; this is an
operation audit, not another release ledger. A failed/lost response is
`inconclusive` and never retries automatically. Inspect GitHub and rerun the
same command with a reason; it checks for the existing record before any create.
GitHub's tag/release uniqueness handles concurrent creates. The explicit owner
workflow in GitHub is the audited admin disposition for editorial disagreement;
it cannot manufacture deployment or acceptance evidence in Tin Star.

Set `enabled` to `false` (or remove the file) to stop future invocations.
An already submitted GitHub request can finish. Published records are not
deleted and tags are never removed. Correct a published record through the
existing owner GitHub workflow after inspecting downstream listeners.

Implementation validation uses synthetic coordinator exports, D.3 receipts
and fake GitHub transports/`gh-axi` only. No real GitHub Releases API, writer,
live config or production mutation is exercised by this task.
