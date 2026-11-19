# Decision Desk

The Desk reviews prepared Notion cards from the configured work board. A card
needs Will when its owner is Will, it has an active Will action tag, or its
status is Waiting For and Will is one of its blockers. Todo, Backlog, Archived,
Done, and trashed cards stay out of preparation and review. A card that needs
Will is ready to claim when it has a current packet, no active lease, and no
blocking source-write reservation or answer save in progress. An answer retires
the answered revision. A substantive
change can open a new decision when the card needs Will again. The Decisions
Workbench remains the view for browsing source requests and their evidence.

## Review and Preparation UI

Open **Decisions** and select **Decision Desk**. Review shows the summary,
options, recommendation, and links for the card held by this browser. Select
an option and enter the words to record. **Record answer & next** saves one card
comment with the chosen option and the exact answer. Tin Star uses its own
integration identity and clears the Will action tag. On a Waiting For card,
Tin Star removes Will’s waits, transfers ownership to Firstmate if Will owned
the card, and sets the status to Queued once all waits are clear. **Skip**
releases the card while keeping its packet available.

Browser review uses the existing Tailscale owner authorization, origin
allowlist, and `X-Tinstar-UI: 1` handshake.

Preparation shows how many cards are ready, being prepared, and leased.
When fewer than ten cards are claimable, Tin Star sends eligible cards up to
a total of ten outstanding jobs. A card is sent only when its evidence has
exactly one open, unanswered Tin Star decision request for Will with a question.
Review submissions and merge asks alone do not qualify. Done, Archived, Waiting for Prod
Release, Delegated to person, synthetic,
test (`[TEST ...]` titles), and Jira cards are not sent. Ownership or a Will
action tag alone does not qualify. A card can have only one outstanding job.
Jobs expire after 15 minutes without publication and are sent at most twice
for one source revision. A changed source revision can be sent again while the
request is open. A Desk answer closes the request until a new request is made.
A job already queued for a card that stops being eligible is dropped.
Published packets have no age limit. Editing decision properties, card text, or
substantive discussion invalidates the packet. Sending happens only when the
preparer webhook secret is configured.

For a prepared card with an open Notion request, see
[withdrawing or superseding a decision request](workflow.md#decision-retractions).

### Answer attribution

The card comment and any corresponding Firstmate update use the Desk caller
identity to introduce the selected option.

| Desk caller | Wording |
| --- | --- |
| Browser owner review or MCP caller `owner-chatgpt` | `Will chose` |
| MCP caller `Firstmate` | `Firstmate chose on Will's behalf` |
| Other MCP callers | `Chosen on Will's behalf (not by Will)` |

Tin Star stores the attribution with the answer attempt and reuses it if a
retry or refill completes the handoff.

## Webhook publication

Configure the `url` and `key` fields of Clavis secret
`grok/tinstar-decision-prep`. Tin Star sends a POST per card with Bearer
authentication. Its body contains `card_url`, a credential-scrubbed
`source_question` from the sole open decision request and an opaque
`source_revision` token for the card revision. Workflow-generated questions can
span multiple lines. Legacy requests contribute only the labeled Question line.
The `publish` object names the callback tool in `publish.tool` and provides its
job ID in `publish.job_id`. Call `publish_prepared_packet` with that job ID and the
four packet content fields.

```json
{
  "job_id": "00000000-0000-4000-8000-000000000001",
  "packet": {
    "summary": "The proposed preview passed its smoke test.",
    "options": [
      { "label": "Approve the preview" },
      { "label": "Record feedback only" }
    ],
    "recommendation": "Approve the preview so Firstmate can continue.",
    "links": [{ "label": "Smoke test", "url": "https://example.com/evidence" }]
  }
}
```

Tin Star attaches the card ID and its revision, assigns option IDs, and reports
invalid packet fields by path. Use HTTPS evidence links without embedded
credentials to make them visible in browser review. The authoritative packet
schema is exposed by MCP `tools/list`. A repeated publish for the same job
returns the same packet ID. Jobs and packets from the former request-based protocol are kept
in local storage for audit. Active cards receive new card-based preparations.

## ChatGPT claims

Call `claim_next_card` or `claim_next_prepared_decision` with a unique
`operation_id`. The claim returns the packet and a per-card lease.
`claim_card` and `claim_prepared_decision` accept an exact `card_id`.
A scoped claim stays within that card when submitting or skipping. To move to
another card after a scoped review, issue an unscoped claim explicitly.

Keep lease and review session tokens in tool arguments. Call `submit_prepared_decision` with
`lease_token`, the selected `option_id`, the exact `answer`, and a new
`operation_id`. Reuse the same arguments when a save result is uncertain.
To continue reading an existing hold, call the claim with its lease token.
For an unscoped review, the answer returns the next prepared card when available.
`release_prepared_decision` can release the hold or skip the card with
`action: "skip"`. Use `open_prepared_review_session` to register a context
explicitly and retain its `review_session_token` across claims.
`list_prepared_review_sessions` lists the caller's contexts without returning
their capabilities. Claim audits record outcomes and timing.

## Per-card source-write reservations and recovery

Browser and MCP claims use the same canonical per-card lease. The storage
transaction binds the conversation to the packet and prevents independent
chats from holding the same card. Leases last 60 minutes and successful holder
writes renew the lease. Background preparation never owns a review lease.

Source mutations acquire per-card reservations. An interrupted write is
checked against the card before any retry, and ambiguous provider writes can
be inspected and reconciled through the existing audited source-write API.
If the answer comment saves before the property handoff completes, retrying
the same operation or the next refill pass completes the handoff while the
same decision revision remains, including its owner, Will action tags, and
wait fields, and the card still needs Will. Otherwise Tin Star
preserves the saved answer and the current card properties. Releasing the lease
keeps the saved answer. Other cards remain available while a
write is resolved. Reminder reservations
can coexist with a review claim and continue to serialize actual source writes.
