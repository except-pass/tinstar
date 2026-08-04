---
date: 2026-08-03
topic: session-time-usage
---

# Session time usage

## Summary

Show where a run's wall-clock time actually goes, as vertical coloured strips in the Run Workspace
telemetry rail, reconstructed from the session's own transcript. The strips separate time the agent
spent working from time it spent waiting on the user, and separate the two kinds of waiting the user
cannot currently distinguish: an approval prompt nobody noticed, and a question awaiting an answer.

---

## Problem Frame

A long-running session is indistinguishable from a stuck one. The dashboard reports a status light
and a duty cycle, neither of which answers "is this working or spinning?" — and neither of which
surfaces the failure mode that dominates in practice.

Measured on the live `codexTinstar` session (97h of life, 72MB transcript, 8,459 tool calls):

- **25.2 hours — 26% of the session's entire life — was spent parked on seven `rm -rf` approval
  prompts.** The longest single one was 8.8 hours. Every one of them is a temp-directory cleanup
  under `/tmp/compound-engineering-1000/ce-code-review/`.
- The first of those prompts reports `Wall time: 0.0000 seconds` in its own output. The command took
  no time at all; the 528 minutes were entirely the prompt sitting unanswered.
- Only 8% of the session was the agent waiting on the user between turns. The user was not the
  bottleneck in the way anyone assumed — the *unnoticed prompts* were.

The same measurement across all nine open sessions found `enrollment` at 73% idle over 116 hours,
`openclawRuntime` at 93% idle over 70 hours, and 110 non-zero tool exits in `codexTinstar` that no
surface reports today.

None of this is visible anywhere in Tinstar. The information exists — every transcript stamps every
entry — but nothing reads it.

The narrower framing ("add a chart") misses what makes this tractable: the data is **retroactive**.
A user can point this at a session that has already been grinding for three days and get an exact
answer, without having instrumented anything in advance.

---

## Key Decisions

**Reconstruct from the transcript; do not build a live recorder** (session-settled: user-directed —
chosen over recording status transitions as the watcher computes them). The transcript is exact, is
already on disk, pairs every tool call to its result by id, and works on sessions that started
before this feature existed. A live recorder starts at zero and cannot explain the turn that
prompted the question. Governs R1–R4.

**Approval stalls are measured, not inferred, wherever the tool reports its own runtime**
(session-settled). Codex `exec_command` prints `Wall time: N seconds` in its output. The stall is
`(result timestamp − call timestamp) − reported runtime`. When that gap is minutes and the reported
runtime is zero, the agent was parked on a prompt. This is arithmetic, not a heuristic. Governs R5.

**A rare band outranks a common one when they land on the same pixel** (session-settled). At rail
scale one pixel is minutes to tens of minutes. Awarding each pixel by pure occupancy hides exactly
the short approval stall the feature exists to surface; awarding it by pure priority made a 73%-idle
session look busy. The rule is occupancy, with an override only for the two "waiting on you" bands.
Governs R11.

**A shorter stretch of time draws a shorter bar** (session-settled: user-directed — chosen over each
strip stretching to fill the rail). Length is the cheapest channel for "how much time is this?", and
the user reported it was what made the spike's strips readable against one another. Governs R10.

**Strips run vertically, past at top, present at bottom** (session-settled: user-directed — chosen
over horizontal strips). Measured on the live dashboard the rail is 160 × 1184px, of which ~730px is
currently available below the session section. Vertical gives the time axis 4.5x the runway and lets
all three ranges sit side by side as parallel columns. Governs R9–R10.

**"Model thinking" is a residual and must be labelled as one** (session-settled). It is in-turn time
with no tool outstanding. It absorbs genuine reasoning *and* any activity the transcript format does
not record. It is an upper bound, not a measurement, and the UI must not imply otherwise. Governs
R20.

**Parsing is incremental and cached; a full re-read per poll is not viable** (session-settled). The
largest live transcript is 72MB / 40,826 lines. Governs R14–R16.

**The trailing window ships fixed but stays parameterised** (session-settled: user-directed — chosen
over shipping the spike's 15m/1h/4h/12h/24h selector). One hour is the default everywhere, no control
is drawn, and no layer hardcodes the number — so adding the selector later is additive rather than a
refactor. Governs R9a.

---

## Actors

- **The user**, scanning the rail to decide whether a run needs attention.
- **The Run Workspace telemetry rail**, which hosts the strips.
- **The session's agent CLI** (Claude Code or Codex), which writes the transcript. It is never asked
  for anything; it is only read.

---

## Requirements

### Reconstruction

- **R1.** The server reconstructs a session's timeline from its own transcript, supporting both the
  Claude Code format (`~/.claude/projects/<encoded-workdir>/<convId>.jsonl`) and the Codex rollout
  format (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
- **R2.** Every instant between the transcript's first and last entry belongs to exactly one band.
  The bands sum to wall clock. Overlapping observations — a script that shells out, concurrent
  sub-agent polling — resolve by priority: approval > question > sub-agent > compaction > tool >
  idle > thinking.
- **R3.** Bands are: `approval`, `question`, `idle`, `subagent`, `tool`, `think`, `compact`.
- **R4.** A tool call with no logged result is **not** treated as still running. If any entry was
  logged after it, the call is closed at that entry and labelled unresolved. Only a call with
  nothing after it is in flight. (Codex drops the output line when a call is interrupted; treating
  those as live produced a 34.9-hour phantom band that painted over a day and a half of real work.)

### Classifying the two kinds of waiting

- **R5.** Approval time is derived by subtracting a tool's self-reported runtime from its observed
  span, where the tool reports one. A gap over 45 seconds where the process ran for less than half
  the span is approval time.
- **R6.** Where a tool does not report a usable runtime — Codex's script-wrapped `exec`, which
  reports elapsed-including-stall — a multi-minute call whose command is a trivial
  `rm`/`mv`/`chmod`/`chown`/`kill`/`git push` is classified as approval. This is a heuristic and is
  documented as one.
- **R7.** Question time is exact: `AskUserQuestion`, `ExitPlanMode` and Codex `request_user_input`
  are ordinary tool calls, so the span from question asked to answer recorded is directly measured.
- **R8.** A Claude tool result carrying a rejection marker is classified as approval (rejected). An
  *approved* Claude permission prompt leaves no trace in the transcript and is a known blind spot,
  recorded in Scope Boundaries.

### Rail presentation

- **R9.** The rail renders three vertical strips side by side: whole session, trailing window, and
  current-or-last turn. Time runs top (past) to bottom (present).
- **R9a.** The trailing window ships fixed at one hour, but the duration is never a literal at a use
  site. It is a single exported default that the route accepts as a query parameter and the hook
  accepts as an argument, so making it adjustable later is adding a control, not threading a value
  through three layers. `useTurnLengthObservations(sessionName, windowSec = 3600)` is the existing
  precedent for this shape.
- **R10.** Strip length reflects real duration on a compressed scale, so a short turn reads as a
  short strip, without a 30-minute turn beside a 116-hour session collapsing to a sliver. Concretely,
  a strip's length is `(duration / longestStripOnThisCard) ^ 0.32`, clamped to a readable floor —
  the curve the spike used and the behaviour the user asked to keep. Strips do **not** each stretch
  to fill the available height; length carries meaning and must stay comparable between the three.
- **R11.** Where several bands land on one pixel, the pixel goes to whichever band occupies most of
  it, except that any `approval` or `question` time present wins outright. This is a rendering rule
  and is distinct from R2, which resolves genuinely overlapping observations before any band exists.
- **R12.** Failure markers sit in a gutter beside each strip: a filled mark for a tool that exited
  non-zero, a hollow mark for an interrupted sub-agent. Marks that would overlap merge into one
  carrying a count. Only an exit code counts as a failure — the words "error" and "failed" appear in
  roughly 1,800 tool outputs in the measured corpus, nearly all of them grep hits and test
  summaries.
- **R13.** The panel is gated by a `telemetryPanels.timeline` config key, matching the existing
  `cost` / `tokens` / `cacheHit` / `duty` / `turnLength` keys.

### Performance

- **R14.** The route parses incrementally from a byte offset and caches per transcript, keyed on file
  size, mirroring the offset bookkeeping `transcript-parser.ts` already uses for recap entries. A
  poll that finds the file unchanged does no parsing work.
- **R15.** A cold parse of the largest live transcript (72MB) yields in slices rather than occupying
  the event loop for the whole read. No single synchronous slice exceeds ~50ms, so a concurrent
  `/api` request waits at most that long behind it. If the first response cannot be complete under
  that constraint it is returned partial and flagged, and completes on a later poll.
- **R16.** The rendered strips composite to one colour per pixel and issue one filled path per
  colour, not one draw call per segment. (Measured in the spike: per-segment drawing pinned a
  transition at 7fps; per-pixel compositing with batched paths brought the median frame to 17.7ms.)

### Honesty

- **R17.** Percentages shown beside a strip are computed from real durations, never from pixels, so
  they stay correct regardless of how compositing resolved any pixel.
- **R18.** A session whose transcript cannot be found renders an explicit "no transcript" state, not
  an empty strip. (`marshal` is a live Codex session with no `workspace.path`; Codex transcripts are
  discovered by working directory, so there is nothing to match on.)
- **R19.** Codex transcript discovery selects the rollout whose own start time is closest to the
  Tinstar session's creation time. Newest-mtime is wrong: a session that spawns sub-agents fills its
  own working directory with their rollouts, and one of those is usually the most recently written
  file.
- **R20.** The `think` band is labelled as a residual/upper bound wherever it is explained to the
  user.

---

## Key Flows

**Scanning the rail.** The user glances at a Run Workspace. The current-turn strip is mostly one
colour. If that colour is red the run is waiting on them and they can act immediately; the previous
signal for this state was a status light that reads "running".

**Explaining a long turn.** The user notices a turn has been open for hours. The turn strip shows
the mix. If it is largely sub-agent violet, the run is orchestrating and the wait is real work; if
it is largely red, a prompt is sitting unanswered.

**Finding what failed.** The user sees marks in the gutter, hovers a cluster, and reads which tools
exited non-zero and with what command.

---

## Acceptance Examples

- **AE1.** Given `codexTinstar`'s transcript, the whole-session strip reports approval ≈ 25.2h
  (26%), tool ≈ 38.8h (40%), think ≈ 17.3h (18%), sub-agent ≈ 7.9h (8%), idle ≈ 7.7h (8%), and the
  bands sum to the 97h span within rounding.
- **AE2.** Given the `exec_command` at 2026-07-31T00:08:24Z whose output reads
  `Wall time: 0.0000 seconds` and whose result lands 528 minutes later, the reconstruction emits a
  single 528-minute `approval` band, not a 528-minute `tool` band.
- **AE3.** Given a Codex tool call with no logged output followed by 4,000 further entries, the
  reconstruction closes it at the next entry — not at "now" — and no band longer than that gap is
  emitted for it.
- **AE4.** Given `enrollment`'s transcript, the whole-session strip renders predominantly in the
  idle colour, consistent with its printed 73%.
- **AE5.** Given a 4-second approval inside a strip where one pixel spans 20 minutes, that pixel
  renders in the approval colour.
- **AE6.** Given `marshal`, which has no resolvable transcript, the panel renders an explicit
  "no transcript" state and no strip.
- **AE7.** Given a poll where the transcript's size is unchanged since the last parse, the route
  performs no file read beyond the size check.

---

## Success Criteria

- A user can tell, from the rail alone and without opening anything, whether a long-running turn is
  working or waiting on them.
- The `rm -rf` stall class — 25 hours lost on one session — becomes visible the first time it
  happens rather than on the third day.
- Polling the route against the largest live session does not measurably degrade dashboard
  responsiveness.

---

## Scope Boundaries

**In scope.** Per-session reconstruction; the three vertical strips in the telemetry rail; failure
markers; both adapters.

**Out of scope for this unit.**

- The by-tool drill-down table. It does not fit in a 160px rail and wants its own surface; it is the
  obvious follow-on and is where the "71% of tool time is `wait_agent` polling" finding came from.
- The multi-session gallery. That was the spike's inspection view, not a product surface.
- Closing the approved-Claude-permission blind spot. That genuinely requires recording the
  watcher's `blocked` flag as it flips (`status-watcher.ts:314` computes it and discards it), which
  is a live recorder and a separate decision.
- `marshal`-class sessions (Codex with no `workspace.path`). R18 makes them render honestly rather
  than wrongly; actually resolving their transcripts is separate work.

---

## Dependencies / Assumptions

- Transcripts remain readable at their current paths and keep per-entry timestamps.
- `Wall time:` remains present in Codex `exec_command` output. If it disappears, R5 degrades to R6's
  heuristic and the approval band under-reports — it does not become wrong.
- The telemetry rail keeps roughly its current vertical budget. If the rail gains panels, the strips
  shrink rather than break.
- New `/api` routes do not go live on the standalone at :5273 until `dist` is rebuilt and the server
  restarted; route handlers are unit-tested and live smoke is deferred to the user.

---

## Outstanding Questions

None. The last open item — whether the three columns share a vertical scale or each fill the height
— is settled in R10: they share the compressed scale, because a shorter stretch of time reading as a
shorter bar is what makes the three directly comparable at a glance.

---

## Sources / Research

- Spike artifact, all nine open sessions, published 2026-08-03:
  `https://claude.ai/code/artifact/09e048cd-2d43-4456-83b1-5ace36d9fb73`
- Measured transcript:
  `~/.codex/sessions/2026/07/30/rollout-2026-07-30T12-53-41-019fb3f2-3036-7840-8742-e65233fe0b5a.jsonl`
  (72.9MB, 40,826 lines, 27 turns).
- Existing precedent for a rail panel: `src/components/RunWorkspaceWidget/TurnLengthPanel.tsx` plus
  `src/hooks/useTurnLengthObservations.ts` and `src/components/Telemetry/TurnLengthHistogram.tsx`.
- Rail dimensions measured live on :5273 — 160 × 1184px, session section 408px, turn-length panel
  155px.
- Status derivation and the discarded `blocked` signal: `src/server/sessions/status-watcher.ts`.
- Transcript offset bookkeeping to mirror for R14: `src/server/sessions/transcript-parser.ts`.
