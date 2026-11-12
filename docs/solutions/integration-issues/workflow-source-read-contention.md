---
title: Workflow writes fail on transient exact-card reads
date: 2026-11-12
category: integration-issues
module: src/server/reconciliation
problem_type: integration_issue
root_cause: timing_error
resolution_type: code_fix
tags: [workflow, notion, source-reads, pacing, retries]
---

# Workflow writes fail on transient exact-card reads

The November 12 workflow acceptance recorded `not-saved / source-unavailable`
for checkpoint, edit and complete, interspersed with successful exact-card
reads and successful writes. One checkpoint returned `partially-saved /
save-unconfirmed`, and one `get_work` returned `stale`.

## Read path and failure mechanism

`WorkflowOperations.performUpdate` already reads the configured source's exact
card through `WorkReader.card(id, true)` and `readNotionCard`. It reads again
after planning, immediately before mutation, and again to verify saved fields.
Ordinary checkpoint, edit and complete do not require a board census. Notes
and managed sections have their own exact content reads; the generic failure
message does not identify which read failed.

The exact page read creates a five-second timeout **before** entering
`NotionApi`'s shared serial queue. Background source queries, reconciliation,
watchdog traffic and interactive calls share this queue, including pacing and
429 Retry-After delays. The timeout can therefore expire before any page GET
is submitted. Originally the queue waited for its predecessor even after the
signal expired, and the page reader made only one attempt. A transient HTTP
error or network failure also immediately failed the operation.

This explains how an independent successful read can coexist with a failed
write: they have separate queue positions/deadlines, writes require several
fresh reads, and an ordinary `get_work` can also reuse its card cache. A card
omitted by a board query or a just-created card missing from a board cache
cannot cause these ordinary write preconditions to fail; they use page GETs.

`ReconciliationSources.getWork` returns `stale` when its read/refresh/details
path throws and `WorkReader.lastKnown` has a card. This preserves previous
data with unknown coverage; it is not a stale-write or version-conflict result.
Its catch also covers refresh reconciliation and details, so that outcome
alone cannot locate the failed stage.

The supplied acceptance artifacts (`result.json` and `result2.json` under
`/home/farm/fm-home/data/tinstar-workflow-acceptance/`) retain public outcomes,
not underlying Notion statuses, exceptions or queue timing. They establish
the intermittent failures but cannot distinguish the cause of each live
failure. The queue deadline mechanism is reproduced deterministically below;
attributing a particular live failure to a 429 rather than a queued timeout
would require additional evidence.

## Fix and evidence

Exact-card GETs now make at most three attempts for timeout/network failures,
HTTP 408, 429 and 5xx, with 250ms/500ms backoff and a fresh five-second deadline
per attempt. The shared queue still honors Retry-After. Waiting for queue
admission now observes cancellation without allowing later requests to bypass
the active request or its pacing delay. Permanent HTTP failures, malformed
responses, and card/source identity mismatches are not retried.

The [workflow regression tests](../../../src/server/reconciliation/__tests__/workflow.test.ts)
hold a fake refresh ahead of the exact read for six seconds. Before the fix,
complete returns `not-saved`; after the fix, it saves once. Additional cases
cover checkpoint/edit/complete failures in initial reads, pre-mutation reads
and readback, changed preconditions during retry, exhausted reads with cached
data present, throttling, and uncertain writes. The
[queue test](../../../src/server/reconciliation/__tests__/notionApi.test.ts)
checks cancellation and ordering while an earlier request remains active.

Only reads are retried. Preconditions are still compared against the fresh
retry result. A failure before submission remains `not-saved`; an exhausted
readback after submission remains `partially-saved / save-unconfirmed`, and
repeating that operation does not replay its uncertain write. Tests use fake
sources and do not contact the live floor or Notion.
