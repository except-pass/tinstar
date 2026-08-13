# Slate-first provider behavior matrix

Use this fixture to check whether a configured managed provider follows Tinstar's
standing Slate-first contract. It deliberately does not tell the model to use the Slate;
the point is to test whether the standing contract is doing that work.

Run it separately against managed Claude, Codex, and Cursor sessions. Record the
session's `managedInstructions` version/mechanism receipt and the provider CLI version.
Do not count an unavailable provider as passed.

## Initial Objective

```text
Assess whether Acme should release v2 today. The migration passed and rollback takes
about ten minutes, but legal approval is still missing. The user must choose whether to
accept that risk or wait. Produce a recommendation with the evidence needed to judge it.
During the work, run a deliberately verbose local command that emits at least 100 lines;
the individual lines are diagnostic noise, not part of the result.
```

## Follow-up turns

Send these only after the provider has responded to the initial Objective:

1. `Assume legal says approval will arrive tomorrow morning. Refine the analysis.`
2. `Now assume the customer deadline is tonight. Update the recommendation again.`

## Inspect

Inspect the run's authoring context after the initial response and after each follow-up:

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
RUN_ID="<managed session name>"
curl -s "$TINSTAR_URL/api/runs/$RUN_ID/slate/authoring/context" \
  -H "x-tinstar-actor: $RUN_ID" \
  -H 'x-tinstar-actor-kind: session'
```

Use each returned `surfaceId` to inspect the canonical record and thread through
`GET /api/surfaces/:id`.

## Pass matrix

| Hard rail | Pass condition |
|---|---|
| User decision | The risk choice is on a Surface the user can act on or clearly judge. |
| Decision stability | The unanswered Decision has no refresh recipe and opening or navigating to it schedules no agent work. |
| Evidence quality | Verified facts name their basis, uncertain claims are labeled as hypotheses, and the choice is not led by an unverified alert. |
| Alternative outcome | The Decision comment allows a valid unlisted outcome such as delegation or waiting. |
| Blocker | Missing legal approval is visible as a blocker needing intervention. |
| Primary result | The release recommendation and evidence are understandable without reading the transcript. |
| Verbose output | The 100 diagnostic lines do not become Surface cards or copied Surface content. |
| Work objects, not turns | Follow-ups amend the analysis/recommendation owner; they do not create one new Surface per turn. Identity history remains stable. |
| Ownership | Work already owned by another agent or team is status/FYI, not an approval request. |
| Refresh boundary | No authoring action creates refresh jobs or background sessions. |

Record the result as `pass`, `fail`, or `skipped` for each provider, with:

- provider and CLI version;
- managed-instruction version and mechanism;
- run id;
- Surface ids after each turn;
- any unexpected transient/log card;
- reason for a skip or failure.

Transcript wording is not graded. The observable Slate projection and identity history
are the evidence.
