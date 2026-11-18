# Decision Desk

The Desk reviews prepared cards from the configured work board. A card needs Will
when its owner is Will, it has a Will action tag, or it is Waiting For Will.
Todo, Backlog, Archived, Done, and trashed cards stay out of preparation and
review. An answer retires the answered revision. A substantive change can open
a new decision when the card needs Will again. The Decisions Workbench remains the view
for browsing source requests and their evidence.

## Review and Preparation UI

Open **Decisions** and select **Decision Desk**. Review shows the summary,
options, recommendation, and links for the card held by this browser. Select
an option and enter the words to record. **Record answer & next** saves one card
comment with the chosen option and the exact answer. Tin Star uses its own
integration identity. It clears the Will action tag and any wait for Will,
assigns the card to Firstmate, and keeps it Waiting For while an independent
blocker remains. It sets the status to Queued when all waits are clear. **Skip** releases the card while keeping its packet available.

Preparation shows how many cards are ready, being prepared, and leased.
When fewer than ten cards are claimable, Tin Star sends a batch of up to ten
eligible cards without outstanding jobs. Each card can have one outstanding job. Jobs expire after
15 minutes without publication. Published packets have no age limit. Editing the
decision properties, card text, or substantive discussion invalidates the packet.

## Webhook publication

Configure the `url` and `key` fields of Clavis secret
`grok/tinstar-decision-prep`. Tin Star sends a POST per card with Bearer
authentication. Its body contains `card_url`, a credential-scrubbed
`source_question`, an empty `options` array for the preparer to propose choices,
and an opaque `source_revision` token for the card revision. The `publish`
object names the callback tool in `publish.tool` and provides its job ID in
`publish.job_id`. Call `publish_prepared_packet` with that job ID and the
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

Each option contains its label.
Tin Star attaches the card ID and its revision, assigns option IDs, and reports
missing packet fields by name. A repeated publish for the same job returns the
same packet. Jobs and packets from the former request-based protocol are kept
in local storage for audit. Active cards receive new card-based preparations.

## ChatGPT claims

Call `claim_next_card` or `claim_next_prepared_decision` with a unique
`operation_id`. The claim returns the packet and a per-card lease.
`claim_card` and `claim_prepared_decision` accept an exact `card_id`.
A scoped claim stays within that card when submitting or skipping. To move to
another card after a scoped review, issue an unscoped claim explicitly.

Keep the lease token in tool arguments. Call `submit_prepared_decision` with
`lease_token`, the selected `option_id`, Will's exact `answer`, and a new
`operation_id`. Reuse the same arguments when a save result is uncertain.
To continue reading an existing hold, call the claim with its lease token.
For an unscoped review, the answer returns the next prepared card when available.

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
same actionable revision remains. If the card changes, Tin Star preserves
the saved answer and the current card properties. Releasing the lease
keeps the saved answer. Other cards remain available while a
write is resolved. Reminder reservations
can coexist with a review claim and continue to serialize actual source writes.
