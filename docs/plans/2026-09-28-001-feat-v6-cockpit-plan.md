---
title: Tin Star V6 Cockpit - Release 1 Plan
type: feat
date: 2026-09-28
topic: v6-cockpit
---

# Tin Star V6 cockpit — release 1 plan

## Goal

Replace the V5 canvas with a worker cockpit backed by live First Mate state. The [V6 requirements](../brainstorms/2026-09-24-tinstar-v6-requirements.md) are the product contract. This plan stages the first release; requirements assigned to release 2 remain in the product contract.

## Release decisions (2026-09-28)

| Question | Decision |
|---|---|
| Prior attempt | Start from the current main branch; the earlier build is not the release baseline. |
| First release | Worker cockpit. Portfolio and planning come in release 2. |
| Proof | On the live First Mate fleet: reads, view-only terminals, and messages through First Mate's own inbox. |
| Placement | v6 replaces v5 from the first PR; canvas code is removed as v6 grows. |
| Keep from v5 | Tauri desktop app; tailnet/remote access. |
| Remove from v5 | Phone layout; Tin Star's own agent sessions (hands, spawn CLI, agent-skills, Marshal, NATS, simulator). |
| Builders | First Mate crewmates, one PR at a time, proof review precedes the next step. |
| Models | Cheaper models may be used for the work as needed. |
| Go-ahead | Release 1 implementation authorized on 2026-09-28. |

## Release 1 integration

**Read (no First Mate change).**
- Tin Star runs `<home>/bin/fm-fleet-snapshot.sh --json` for each configured `firstmate.homes` entry. That setting already exists (`src/server/index.ts:1639-1657`).
  - The snapshot is First Mate's documented worker view: schema `fm-fleet-snapshot.v1` (`bin/fm-fleet-snapshot.sh:4-5`). Its header says views should render it rather than re-parse state files (117-118).
  - It is side-effect free apart from a remote-secondmate summary cache (6-10).
  - It took 3.9 s for 7 tasks. Poll about every 20 s (proposed, tune in step 1), and also re-run it when the fleet ledger file changes. The v5 `ledger-watcher.ts` can serve as that trigger.
- Per worker, the snapshot gives:
  - id, kind, harness, `project`, branch, `spawn_gen`, backend, worktree path;
  - `current_state{state, detail, observed_at, freshness}`;
  - `endpoint.target` (the tmux `session:window`);
  - `pr.url`;
  - `hints.open_decisions[{key, verb, summary}]`;
  - backlog records, including captain-held rows (`fm-fleet-snapshot.sh:855-931`).
- **Objective** = the `## Captain's intent` section of `data/<id>/brief.md`, a documented heading (`bin/fm-brief.sh:6-13`), falling back to the backlog title. It is read-only in release 1.
- **Unknown values stay visible.** Unknown states or fields render as "unknown"; a worker is never dropped (lesson from `descriptor.ts:73-79`).

**Terminal.** Reuse v5 unchanged where possible:
- `FirstmateViews` (`src/server/firstmate/views.ts`, 333 lines).
- `bin/tinstar-fm-view` (69 lines): a private `tsview-*` session that links the worker's window.
- The `/s/<id>/` proxy (`src/server/sessionProxy.ts`).
- `public/terminal-wrapper.html`.

Its safety properties are already tested against a real tmux server (`views.tmux.test.ts:154-259`): killing the view leaves the worker, a disconnect removes only the view, and destructive verbs target only `=tsview-`. The window target should come from the snapshot's `endpoint.target` rather than v5's private `.meta` read (`meta.ts:1-6` calls that format undocumented).

**Write** (release 1's only write to First Mate):
- The call: `fm-inbox.sh note --request-id <id> --json` in that home, with a plain-text body naming the task id, the decision key (when answering), and the submitted response.
- The First Mate primary handles inbox notes on its check wake and acknowledges them (`AGENTS.md:453`). It replies with `fm-inbox.sh reply` when "the note needs a durable answer" (`AGENTS.md:454`).
- **Resolution is observed, not assumed.** Tin Star shows a decision as done when it leaves the snapshot: the status `resolved [key=…]` line landed, or the captain hold closed.
- **No custom envelope.** Nothing in First Mate would parse one.

**Server and UI placement.**
- Server: one new server module added to the handler chain in `src/server/standalone.ts:125-132`. It uses `ok()/fail()`, `readBody`, `getConfigRoot()` and the existing SSE `broadcastEvent`. It emits no new `BusEvent` and uses no NATS (`docs/conventions.md`).
- Frontend: a new two-pane app rendered from `src/App.tsx` in place of `WorkspaceShell`. HTTP goes through `apiFetch`/`apiUrl`, which works in Tauri.
- Proposed: plain names (e.g. `src/cockpit/`, `src/server/fleet/`) rather than `v6` prefixes, since this becomes the product.
- Visual tokens: reuse `tailwind.theme.js`, `tailwind.config.ts` (Chakra Petch / JetBrains Mono, neon accents) and `docs/slate-design-language.md`.

## Release 1 steps

The steps run strictly in order, one PR each. A step starts only after the previous step's proof has been reviewed.

**Proof standard for implementation steps:**
- The proof is the live app on the live First Mate home. Screenshots go in the PR, and each one is checked by an independent blind screenshot QA pass against the acceptance list. Include any live command checks named in the step.
- Tests are regression guards and are never the proof.
- No user-visible text may mention tests, acceptance IDs, fixtures, "slice", or step numbers.
- The only First Mate write in release 1 is `fm-inbox.sh note`.

---

**Step 0: Put the design in the repo** (docs only, small).
- Add the contract as `docs/brainstorms/2026-09-24-tinstar-v6-requirements.md` (existing `*-requirements.md` convention). Rewrite it in neutral voice, dropping first-person attributions.
- Add this release plan as `docs/plans/2026-09-28-001-feat-v6-cockpit-plan.md`.
- Point `docs/VISION.md` at the new requirements as superseding the canvas vision.
- Acceptance: the files are merged to `main`. The requirements keep every R and T item. The plan records the Release decisions decisions.
- Proof: the PR diff and the requirements ID check.
- Why first: the only copy of the design sits in a directory on the cleanup list.

**Step 1: Cockpit thin slice, replacing the canvas at `/`.**
- Scope:
  - The server fleet read (Release 1 integration).
  - Page `/` becomes two panes; `App.tsx` no longer renders `WorkspaceShell`. The canvas code stays until step 2 deletes it.
  - Rail: Overview control, workers.
  - Main area: Overview (workers grouped by state) and Worker view.
  - Worker view:
    - A header with the face, name and identity colour.
    - A state chip, separate from the colour.
    - The objective, project, worktree, branch and PR link, with state detail and freshness.
    - The live terminal.
  - Faces: the existing DiceBear `bottts` avatar seeded by task id (`src/components/agentAvatarCache.ts`, stable per id).
  - Colour: a hash of the task id into `ColorPalette.tsx`. v5 picks colours at random and First Mate runs all get `#00f0ff`, so this is new.
  - Visible previous/next controls.
  - **Ctrl+[ / Ctrl+]** cycle all workers in rail order from anywhere, including inside the terminal. Today the wrapper posts the keys but only the built-in workspace relays them (`RunSessionPanel.tsx:59-88`), so First Mate terminals swallow them. The fix is to add the relay.
- Acceptance:
  - A1. Every task in the live `fm-fleet-snapshot.sh --json` appears once with matching id, state and project. A newly dispatched worker appears within 30 s without reload; a torn-down worker disappears.
  - A2. The worker view shows the brief's objective, worktree path, branch and PR link (when present).
  - A3. The terminal shows the worker's real pane and typing reaches it. Closing the tab, reloading, and opening a second browser all leave the worker's tmux window alive.
  - A4. Ctrl+] / Ctrl+[ cycle through all workers with focus on the page, in a text box, and inside a terminal. The identity header updates immediately. No ttyd restarts and no terminal resize.
  - A5. A worker's face and colour are identical after reload and in a second browser.
  - A6. The page loads over the tailnet address and in the Tauri app.
- Proof:
  - Live screenshots of live First Mate workers (rail, worker view, open terminal).
  - `tmux list-windows -t firstmate` output before and after closing and reloading a view.
  - The ttyd pid and iframe size before and after 10 rapid cycles.
  - Screenshots from the tailnet URL and the Tauri app.
  - A Playwright regression test on a private-socket test home, labelled as regression.

**Step 2: Remove the v5 canvas UI.**
- Scope: delete the infinite canvas, widgets, frontend plugins, Slate and Roundup surfaces, Focus mode, mobile mode and their e2e specs. Keep the tokens, avatar, palette, quota components, `a2ui/controls.ts` plus the decision control, and the terminal wrapper.
- Acceptance: typecheck, build and unit tests pass (`docs/testing.md`: `-p tsconfig.app.json`, `--exclude='e2e/**'`). Nothing imports deleted modules. Step 1's A1-A6 still pass live.
- Proof: a re-run of step 1's live checks with fresh screenshots, plus before/after bundle size.

**Step 3: Needs You from real First Mate data.**
- Cards, keyed so they update in place instead of duplicating:
  - **Decision:**
    - Sources: each `hints.open_decisions` entry with verb `needs-decision`, and each captain-held backlog row.
    - When both sources describe the same call, they become one card.
    - Compact card: headline, the origin worker's face and name, age, and an Open button.
  - **Blocked:** `open_decisions` entries with verb `blocked`, or `current_state.state == blocked`. Shows what is needed and the worker.
  - **Failure:** `current_state.state == failed`, with its detail.
  - **Review Ready:**
    - Triggered by a task with `pr.url` that is not merged.
    - Shows the headline, repository, PR number, and a direct link that opens GitHub.
    - No modal.
    - CI is shown only when known; unknown is shown as unknown.
- Each type has its own icon, layout and text label, so colour never carries type alone.
- Clicking a card never answers or resolves anything.
- Schedule Drift and Contradiction come in release 2; release 1 shows no placeholder for them.
- Acceptance:
  - B1. Every open decision, captain hold, blocked worker, failed worker and unmerged PR on the live home appears exactly once, as the right type.
  - B2. A call resolved in First Mate leaves the rail within one refresh.
  - B3. The four types can be told apart in a grayscale screenshot.
  - B4. A PR card opens `https://github.com/<repo>/pull/<n>`.
- Proof: live screenshots, a grayscale screenshot, and a blind QA pass. The live data may differ at build time.

**Step 4: Answer and message through First Mate.**
- Scope:
  - The Decision card gets an answer box. Worker views and cards get "Tell First Mate about this".
  - Both send one `fm-inbox.sh note --request-id` naming the task, key or card, plus the words. The request id is minted once per submit and reused on retry.
  - States shown: sending → saved → First Mate has it (acknowledged in `receipts`) → done (the call left the snapshot). Any `reply` text appears under the message.
  - When `fm-inbox.sh ready` reports `can_receive` false, a plain banner says the message is saved and will be read when First Mate wakes.
  - Unfinished messages survive reload via a small local outbox under `getConfigRoot()`. It holds request ids and text only and is not a source of truth.
- Acceptance:
  - C1. Answering a real captain call from Tin Star leads First Mate to close it with those words, recorded by `fm-captain-hold.sh answer`, and the card disappears.
  - C2. A double submit or network retry creates one note (`receipts` shows one).
  - C3. With the First Mate primary not listening, the UI says "saved, not yet read".
  - C4. A reply written by First Mate appears under the message.
- Proof: a live end-to-end run on a throwaway captain call that is authorized for this test. It includes screenshots of each state, the `receipts` excerpt, and the backlog row showing the recorded answer.
- Fallback if the First Mate primary does not act on inbox notes reliably:
  - Feed the answer to First Mate's documented channel-agnostic intake, `fm-captain-hold.sh answers --source tinstar`. The chat and Lavish board channels already feed it (`docs/captain-hold-lifecycle.md:51`).
  - Keep the note as a heads-up to First Mate.
  - This closes calls without a First Mate turn, so it needs explicit approval before use.

**Step 5: Quota meters, identity polish, motion.**
- Scope:
  - Compact quota meters at the rail's bottom, reusing `providerObservationsStore.ts`, `ProviderQuotaCards.tsx` and `CcQuotaClock.tsx`.
    - Claude comes from the statusline hook (`/api/cc-quota`).
    - Codex shows where observed.
    - Other providers are labelled unavailable, with the reason.
    - Stale or unavailable data is never drawn as zero or full, and the meters are labelled as provider quota, not context.
    - Delete the dead `CcQuotaCard.tsx`.
  - A visual pass to the Slate design language.
  - Short, interruptible worker-switch transitions that never block input, and that honour `prefers-reduced-motion`.
- Acceptance:
  - D1. Real Claude 5-hour and 7-day numbers with reset time and freshness.
  - D2. A missing or stale feed shows as stale, never as zero.
  - D3. 20 rapid cycles never queue animations or drop keys; reduced motion disables the transitions.
- Proof: screenshots, a short screen recording of rapid cycling, and a blind QA pass.

**Step 6: Remove Tin Star's own agent sessions.**
- Delete:
  - Tin Star-owned session lifecycle and the spawn/send APIs.
  - Hands, wrangler, Marshal.
  - The NATS channels and MCP config.
  - The simulator (`TINSTAR_FAST_SIM`) and transcript-based run status.
  - The spawn CLI commands.
  - `agent-skills/` (verify current installation state before removal).
- Keep:
  - ttyd port management and the proxy.
  - The First Mate views.
  - `cc-quota` and provider observations.
  - The config root, SSE and static serving.
  - Tauri, and `tinstar --host` for the tailnet.
- Acceptance: steps 1, 3, 4 and 5 still pass live. `tinstar` starts with `--host`. The Tauri app builds and loads. No route refers to deleted code.
- Proof: a live re-run with screenshots, plus Tauri and tailnet screenshots.
- Known break: Stretch Plan's `work-the-plan` skill posts to Tin Star's spawn API (contract S7). It stops working here. The [requirements contract](../brainstorms/2026-09-24-tinstar-v6-requirements.md) assigns dispatch to First Mate.

**Step 7: Docs and release 6.0.0.**
- Scope:
  - Update `CLAUDE.md`, `CONCEPTS.md`, `docs/VISION.md`, `docs/architecture.md` (which also wrongly says the backend runs inside Vite, `docs/architecture.md:93`), `docs/conventions.md`, `README.md` and the release notes.
  - Cut 6.0.0 per `docs/releasing.md`.
  - `@tinstar/plugin-api` loses its host. Deprecating it on npm is a separate, explicit publish decision.
- Acceptance: the released package, installed fresh on this machine, starts and shows the live fleet. The operator upgrades `~/tinstar-server` only when he chooses.
- Proof: a screenshot from the released build.

**Size.** Estimate, not measured: steps 1 and 4 are the largest, about a day of crewmate time each including live proof; steps 0, 2, 3, 5 and 7 are small to medium; step 6 is large but mechanical. Roughly 5-7 working days end to end, plus review time between steps.

## Release 1 exclusions

- Portfolio Kanban, initiatives and epics.
- Stretch Plan epic and task views.
- Launching workers.
- Context Threads with guaranteed replies.
- Schedule Drift and Contradiction cards.
- Rich decision options.
- Objective editing.
- Completion aging.
- The native desktop assistant integration (contract T25 remains unverified).


## Risks

| Risk | Evidence | Handling |
|---|---|---|
| The First Mate primary's inbox path has never been used on the live home | No `state/inbox/` directory exists in `/Users/wtg/repo/firstmate` | Step 4 proves it on a throwaway call first; fallback in step 4 |
| Snapshot cost | 3.9 s per run for 7 tasks; the run starts many subprocesses; crew-state may make a 5 s GitHub read | ~20 s poll plus a ledger-change trigger, one run in flight; measure in step 1; consider `FM_CREW_STATE_NO_FORGE=1` only if PR data stays fresh enough |
| First Mate upstream drift | Live checkout `d4f3b78`; upstream is 90 commits ahead. `fm-fleet-snapshot.sh`, `fm-fleet-ledger.sh`, `fm-inbox.sh`, `fm-send.sh` are untouched upstream; `fm-crew-state.sh` and `fm-classify-lib.sh` changed | Target what the live home runs; ignore unknown fields; show unknown states as "unknown" |
| Replacing v5 at step 1 removes Slate, Roundup, plugins and Tin Star hands immediately | Release decision | Accepted; step 1 must cover the live First Mate workflow used by the operator |
| `work-the-plan` breaks at step 6 | Contract S7 | Flagged; it should dispatch through First Mate anyway |
| Ctrl+[ is ESC inside a terminal and the wrapper swallows it | `terminal-wrapper.html` behaviour; also v5's current behaviour | Accepted; the Esc key still works |
| Human typing and First Mate steering can interleave in a worker pane | Contract:538 | Same as v5 today; the terminal is labelled as direct terminal input |
| Stale second-mate data shown as "fresh" | kd second-mate summary was ~217k s old but labelled fresh in the snapshot | Show the observed time next to second-mate rows |
| Scope creep back toward "whole V1" | Prior attempt | Release 1 exclusions is the fixed out-of-scope list; anything new goes to release 2 |
