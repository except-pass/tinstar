---
date: 2026-07-17
topic: roundup
---

# The Roundup

## Summary

A standalone widget where every agent curates a live patch of two things: what it needs from the user, and what it decided on its own. Agents keep it current by posting, amending, and pulling notices, so arriving at it costs a glance instead of a round trip. Notices render from A2UI, so agents emit declarative components rather than markup.

## Problem Frame

The user runs many sessions in parallel, on unrelated topics. The scarce resource is not agent throughput — it is his attention, and specifically the cost of re-entering a session he has been away from.

Today that cost is paid by pulling. He switches to a window, scrolls back, or asks the agent for a recap, waits for it, and often does not understand the recap and asks again. Because the answer is never durable, he pays the full price again on the next switch. He keeps notes to himself in a notepad, out of band, because the product has nowhere to put them.

Past a certain session count this collapses into thrashing: ask session A for a recap, switch to B, ask B for a recap, return to A having lost the thread, ask A to clarify. Every cycle spends attention on switching and none on deciding. That ceiling — not any individual missing feature — is what caps how many agents he can usefully run.

Tinstar already renders facts you would otherwise track in your head: cost, tokens, cache hits, context fullness. It has no answer for "does this agent need me, and what for?" The nearest signals are a derived status enum and a scraped transcript. Neither can state a decision, and neither can take an answer.

## Key Decisions

**The agent authors its notices; we do not derive them.** A transcript scrape cannot produce the three options an agent is stuck between, and cannot judge which of the things it did were worth reporting. Importance is a judgment, and judgment is the payload. The cost is that authoring depends on agent discipline, which is the feature's central risk.

**Notices are mutable state, not mail.** An inbox accrues; agent asks go stale fast, because the agent works around them, decides for itself, or has the branch abandoned under it. A surface full of stale asks is worse than no surface — it stops being trusted, and an untrusted surface is guilt with a badge. The existing attention field dodges staleness by being derived and recomputed. Once notices are durable and authored, staleness becomes the primary enemy, so retraction is a first-class operation rather than an afterthought.

**Lifecycle rides status transitions rather than agent goodwill.** The moment an agent blocks is the moment it should write — it is idle by definition, information is at its peak, and that is exactly when the user needs it. The moment it unblocks is the retraction trigger. The status watcher already tracks both.

**The A2UI protocol over freeform HTML or a hand-rolled format.** Freeform HTML is an opaque iframe: unthemed, untriageable, and different for every agent — which raises re-entry cost, the exact thing being fixed. A2UI is a declarative protocol whose clients render with their own components, so notices inherit the theme and look the same everywhere. The widget is standalone, so the bet is cheap to reverse.

**Adopt the protocol, not the React renderer.** `@a2ui/web_core` carries the message processor, both-direction schemas, and a component binder with no React peer. `@a2ui/react` requires React 19 against this repo's React 18, and dropped React 18 support in a *patch* release (0.10.0 → 0.10.1), which is the clearest available signal about how still this dependency holds. Mapping components to the host's own Tailwind ones is work R15 requires regardless — the stock catalog was never going to match the theme. What is worth buying is the protocol design; what is not worth buying is a renderer we would have had to override.

**One shared widget, not a rail inside each run.** Triage across sessions is the pain. No per-run surface can answer "what is open everywhere" without visiting each run, which is the thrash being escaped.

**The Roundup is the view; a notice is the item.** "Roundup" names what the user gets — gathering what is scattered across sessions. It gives agents no verbs, so the item carries them: agents *post* a notice, *amend* it, and *pull* it down. Every verb is reversible, which encodes the lifecycle in the vocabulary agents read.

**The Roundup coexists with the sidebar Inbox.** The Inbox lists derived status for every session and is not changed by this work. The Roundup carries authored substance. Two surfaces, two jobs.

**De-nerd depth is a requirement, not a style note.** The value is arriving cold and getting oriented without a round trip. A notice written in agent shorthand fails at precisely the moment it is supposed to work.

## Actors

- A1. **The user** — reads the Roundup, answers notices, dissents from FYIs. Never asked to poll or prompt for status.
- A2. **An agent** — a managed session. Curates its own section: posts, amends, and pulls its own notices, and no one else's.
- A3. **A hand** — a spawned child session. Same as A2; its notices appear alongside its spawner's rather than nested under them.

## Key Flows

F1. **An agent needs a ruling.**
**Trigger:** the agent reaches a decision it should not make alone.
The agent posts a needs-you notice carrying a headline, background, and the options it is stuck between. The user arrives, expands it, reads enough to decide without asking anything, picks an option, optionally adds free text, and submits. The answer reaches the agent, which resumes and pulls the notice.

F2. **An agent decided on its own.**
**Trigger:** the agent made a call the user would want to know about but that does not block it.
The agent posts an FYI and keeps working. Silence is consent. If the user disagrees, the dissent reaches the agent as an interruption.

F3. **The situation changes before the user looks.**
**Trigger:** a posted notice stops being true — the agent found another route, a sibling answered it, the branch died.
The agent amends the notice or pulls it. The user never sees a question that no longer matters.

F4. **The run ends with notices standing.**
**Trigger:** a run stops or is deleted while its notices are still posted.
Its notices leave the Roundup with it. A dead agent cannot answer, so its asks must not outlive it.

## Requirements

**The surface**

- R1. The Roundup is a standalone widget, spawnable from the palette, scoped to a space.
- R2. It is sectioned by agent, and each section is attributed to its run.
- R3. An agent can write only to its own section.
- R4. It renders two notice kinds, visually distinct at a glance: needs-you and FYI.
- R5. It is readable without expanding anything — every notice presents a scannable headline before its detail.
- R6. The existing sidebar Inbox is unchanged by this work.
- R7. The telemetry rail is unchanged by this work.

**Notices**

- R8. A notice carries a headline and expandable background.
- R9. Background is written at de-nerd depth: plain words, jargon unpacked, precision kept.
- R10. A needs-you notice may carry a choice set, rendered as single-select or multi-select.
- R11. A needs-you notice may carry a free-text field, available with or without a choice set.
- R12. A notice may carry links out to external systems, so work that must happen elsewhere surfaces here.
- R13. An FYI carries a dissent affordance. Without one, "nothing is needed unless I disagree" has no mechanism.
- R14. Agents describe notices as A2UI component descriptions, not markup.
- R15. Notices render through the host's own components and inherit the host theme.
- R16. Invalid or unrenderable component descriptions degrade to something readable rather than to a blank notice. An agent that gets the schema wrong must still reach the user.

**Keeping it honest**

- R17. An agent can amend a posted notice in place, and the change reaches the user live.
- R18. An agent can pull a notice it posted.
- R19. Posting and amending are anchored to the moment an agent blocks; retraction is anchored to the moment it unblocks.
- R20. A notice does not outlive the run that posted it.
- R21. A notice records when it was posted and when it was last amended.

**Answering back**

- R22. Submitting a needs-you notice delivers the choice and free text to the posting agent.
- R23. Dissenting from an FYI delivers the objection to the posting agent.
- R24. The user gets immediate visual feedback on submit, without waiting for the agent to acknowledge.

**Teaching agents**

- R25. An agent skill documents the protocol: when to post, what belongs in each kind, the depth bar for background, and — most importantly — when to amend and pull.

## Acceptance Examples

- AE1. **Covers R18, R19.** An agent posts a needs-you notice, then finds another route before the user ever looks. The notice is gone when the user arrives. No ghost question.
- AE2. **Covers R13, R23.** An FYI says a flaky e2e test was skipped on CI. The user does nothing; the agent keeps working. Had the user dissented, the agent would have been interrupted with the objection.
- AE3. **Covers R20.** A run is deleted while holding two posted notices. Both leave the Roundup. Nothing remains that points at a session that no longer exists.
- AE4. **Covers R5, R9.** The user opens the Roundup cold, having not seen this agent in an hour. He reads the headline, expands one notice, and decides — without asking the agent anything.
- AE5. **Covers R17.** An agent posts a decision with three options, then discovers a fourth. It amends in place; the user sees four options without a second notice appearing.
- AE6. **Covers R11.** A needs-you notice offers no choices at all — only background and a free-text field. It renders and submits.
- AE7. **Covers R16.** An agent posts a notice whose component description fails schema validation. The user still sees a headline and something readable, plus a signal that the agent malformed it — not an empty card and not silence.

## Scope Boundaries

- **Swimlanes.** Rendering a branched conversation as parallel lanes is a different problem: it is about reading the transcript, not about knowing what needs you. Deferred.
- **Delegation as its own feature.** "A hand is working on X, jump to it" rides in as an FYI carrying a link. It does not get bespoke machinery.
- **A per-run rail.** Considered and rejected; triage is cross-run.
- **Replacing the sidebar Inbox or the telemetry rail.** Neither moves.
- **Deriving notices from transcripts.** Rejected — it cannot produce choices, and cannot judge importance.

## Dependencies / Assumptions

- **A2UI** is Apache 2.0, Google-created. `@a2ui/web_core` (0.10.4) carries the protocol with no React peer: message processor, zod schemas in both directions, a component binder, a basic catalog, and side-by-side `v0_8` / `v0_9` namespaces. Its signal implementation is pluggable.
- **`@a2ui/react` is not usable here.** It peers on React 19 as of 0.10.1; this repo is React 18. Adopting it would drag a React 19 migration into this feature.
- **The dependency does not hold still.** React 18 support was dropped between 0.10.0 and 0.10.1 — a patch release removing a peer major. Assume breaking changes arrive in releases that claim not to carry them, and pin accordingly.
- **The published docs are stale relative to the packages.** a2ui.org describes v0.9.1 as current with v1.0 a candidate, while npm is shipping 0.10.x. Trust the packages over the site.
- **Assumed: agents will actually maintain their notices.** This is the feature's central bet and it is unproven. Anchoring lifecycle to status transitions (R19) is the mitigation; if it fails, the Roundup goes stale and stops being trusted.
- **Assumed: models emit valid A2UI reliably** for whatever catalog we settle on. Unmeasured — R16 exists because this assumption will sometimes be false.
- **Agents that never learn the protocol** (Codex, cursor-agent) will post nothing. Their sections stay empty rather than breaking.

## Outstanding Questions

**Deferred to planning**

- Which A2UI schema namespace to build against (`v0_9` is current in `web_core`), and how much of the client-to-server schema to adopt for the submit path (R22, R23) versus carrying our own.
- Which components the catalog needs beyond what R8–R13 imply, and whether the stock basic catalog is a useful starting point or a distraction.

- How notices rank and order within and across sections.
- Whether notices carry read state, and whether it is per-browser like the Inbox's.
- The exact delivery mechanism from submit back to the agent. Note replies already solve this shape by baking a `curl` into the prompt (`src/pins/replyPrompt.ts:10`); whether that pattern is the target or merely the precedent is a planning call.

## Sources / Research

- `src/hooks/useInbox.ts` — the existing Inbox: a pure derivation over runs and plugin-widget attention. `useInbox.ts:69` already describes itself as an email inbox. Explains what the Roundup is *not* duplicating.
- `src/server/stores/document-store.ts:61` — `deriveRunAttention`, the only "this agent needs you" signal today: a 3-level enum plus a short reason, recomputed from status.
- `src/domain/pinSet.ts`, `docs/features/2026-06-13-note-replies-design.md` — notes/replies: an existing threaded, two-way, agent-authored, SSE-live channel. The closest working precedent, including its agent-facing write path. Its design doc names "cross-widget thread inbox" as an explicit non-goal, which is the seam this work fills.
- `src/server/sessions/transcript-parser.ts` — how `recapEntries` are scraped. Establishes that recap is derived, not authored.
- `src/server/api/routes.ts:2401` — `/api/artifacts`, the existing agent-pushes-HTML primitive. The freeform-HTML approach this brainstorm rejected already exists here.
- `src/server/api/routes.ts:2518` — `/api/plugin-widgets`, including the `attention` field a plugin widget can set to reach the Inbox.
- `PLACEMENT-API-NOTES.md` — canvas position is client-side config with no live push; constellation slots are docstore-backed and live. The asymmetry constrains any agent-driven placement.
- `src/widgets/CanvasWidgetShell.tsx:426` — plugin widgets mount as in-process React components in the host tree. There is no iframe boundary anywhere in the plugin host, and `tailwind.config.ts` already globs `src/**`, so a plugin widget gets the host theme for free. `PLACEMENT-API-NOTES.md:53` says plugins run in iframes; that is about the stretchplan bridge specifically and is misleading as a general claim.
- `src/plugins/graveyard/src/GraveyardWidget.tsx` — a bundled plugin widget styling itself with host Tailwind classes. The working precedent for R15.
- `docs/essays/out-of-your-brain-onto-the-pane.md` — the product thesis this feature extends from machine state to conversation state.
- https://a2ui.org/ — the spec. Stale relative to the packages; see Dependencies.
- https://www.npmjs.com/package/@a2ui/web_core — the framework-agnostic protocol layer this feature depends on.
