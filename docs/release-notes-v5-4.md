# Tinstar v5.4 — feature reference

Single-source reference for every feature shipped in v5.4. Organized by subsystem. Points at the relevant code and existing timeless docs.

> **Why this doc exists:** v5.3 made agents able to talk back (the Graveyard, Roundup) and made a busy fleet easier to tidy. v5.4 changes what you look at while a run is alive, and closes a hole in how the process listens on the network. Three throughlines: **(1) The Slate** becomes the working surface of a live session — a per-run board of addressable cards (a goal, a decision, a diagram, a progress track) that an agent writes and you answer, now laid out as measured masonry ([ADR 0003](adrs/0003-slate-masonry-reflow.md)). **(2) The canvas tells you where the time and the workers went** — Focus mode for one session at a time, a rail that shows where a run's time went, provider quota and token history, and an opt-in view of [first mate](https://github.com/kunchenguid/firstmate) workers that Tinstar does not own. **(3) Reach and delivery get a real boundary** — the server and every terminal bind loopback unless you opt into tailnet reach, and a prompt sent to Claude or Codex is a durable delivery with a ledger instead of a best-effort poke. Underneath: Project and Worktree replace Initiative, Epic, and Task; Grok can launch as an agent; hands stop receiving each other's messages. The per-feature plans that drove these are retired as the map; this file points at the living code and the timeless docs. Same pattern as `release-notes-v5-3.md`.
>
> One new ADR: [0003 — measured masonry inside the Slate](adrs/0003-slate-masonry-reflow.md). v5.4 still builds on [0001](adrs/0001-response-envelope.md) and [0002](adrs/0002-plugin-api-boundary.md). `@tinstar/plugin-api` ships one surface change: `Reply.author` now includes `'process'`, the author a local `tinstar-run` wrapper uses when it posts on a Slate thread. Pins and notes still only produce `'user'` or `'agent'`.

---

## ⚠️ Breaking change — Tinstar no longer answers on your LAN by default

**Read this one before upgrading.**

Every previous release called `listen(port)` with no address, which binds the unspecified address: one listener on **every interface**. Combined with no authentication layer and per-session `ttyd` processes that each bound every interface too, a Tinstar host with no firewall served an unauthenticated, writable shell — with the operator's git credentials and agent tokens in reach — to anything that could route to it. Nothing in the product said so.

As of v5.4:

- The server binds **`127.0.0.1` and `::1`** and nothing else, unless you name an address.
- Every agent terminal binds `127.0.0.1` only, and additionally requires a header that only Tinstar's own session proxy sends. A terminal port is no longer independently usable, even from the same machine.
- A terminal left running by an older Tinstar is **replaced rather than reused**, because its bind does not match. Existing sessions restart their terminal once on the first start after upgrade. The tmux session behind it — and therefore the agent — is untouched.
- **ttyd 1.7.4 or newer is now required.** Both containment flags (`-i`, `-H`) are silently ignored by older builds rather than rejected, so a terminal spawn is refused below that floor instead of quietly serving a world-reachable shell. `tinstar doctor` reports the installed version against it.

### What still works, unchanged

`http://localhost:<port>` on the host machine. Every host-local caller keeps working with no configuration: the `cc-quota` statusline shim, project `.claude/settings.json` hooks, `tinstar doctor`, `tinstar status`, agent skills, the built-in hand prompt, and `bin/apiBase.js`. `server.host` still records an IPv4 address that those callers can put in a URL.

### If you were reaching Tinstar from another device

Name the address explicitly:

```bash
tinstar --host 100.x.y.z          # e.g. a tailnet address
tinstar --host 192.168.1.50       # a LAN address
tinstar --host a.b.c.d,e.f.g.h    # or repeat --host
```

`127.0.0.1` is force-added to whatever you name, so host-local callers keep working. `TINSTAR_HOST` takes the same value.

This widens the bind, which is exactly what the containment work narrowed — the whole address is reachable to anything that can route to it, with no authentication in front. Prefer tailnet reach below, which keeps the bind on loopback.

### Preferred: tailnet reach

Reach fronts the loopback bind with `tailscale serve` instead of widening it. Tailnet membership is the authorization; Tinstar ships no credential of its own, and the listener stays on `127.0.0.1`.

```bash
tinstar reach on       # prints the privilege grant, installs it, then enables
tinstar reach status   # where you are reachable, or why not
tinstar reach off      # revokes the mapping and removes the grant
```

The opt-in is persisted, so a restart or reboot brings the same URL back with no second decision — a clean shutdown takes the mapping down but never the preference. `GET /api/reach` returns the same state, so an agent can ask whether it is reachable remotely.

Preconditions, each refused by name rather than generically if unmet:

- **Tailscale 1.98.9 or newer.** Refused below that, not warned. Bulletins TS-2026-005, TS-2026-007 and TS-2026-008 are fixed in 1.98.9, and TS-2026-008 is an unauthenticated denial of service against the exact serve path this turns on, reachable from any tailnet peer.
- **MagicDNS and HTTPS certificates enabled for the tailnet.** Both are admin-console settings, not device settings.
- **The privilege grant installed.** `tinstar reach on` writes a sudoers drop-in at `/etc/sudoers.d/tinstar-reach` permitting exactly the two `tailscale serve` invocations Tinstar issues and nothing else — no other subcommand, no wildcard. It prints the rule before writing it and validates it with `visudo -c` before anything reaches `/etc/sudoers.d`. The grant is installed only when you ask for reach, never by `install-service`; `tinstar reach off` removes it, and you can remove it yourself at any time with `sudo rm /etc/sudoers.d/tinstar-reach`. Tailscale's own `--operator` grant is deliberately *not* used: it confers control of the whole daemon and is the pivot in one of the advisories above.

Run `tinstar doctor` to see the observed bind of every listener, both external version floors, and the current reach state.

**The tailnet is assumed to be single-user** — every member one of your own devices. Default Tailscale ACLs let any member reach any peer, so on a shared tailnet this relocates the exposure rather than closing it. Nothing enforces this; it is a precondition.

### If you installed the systemd unit before v5.4

Regenerate it: `tinstar install-service --port <port>`. The old unit resolved a tailnet IP into `--host` at every start, which re-opens the bind this release closed, and it froze a CORS allowlist at install time that the server now seeds itself. Tinstar warns about a stale unit on every service command rather than only at install.

### Why a runtime notice as well as this note

Tinstar is published to npm and its documented onboarding is `npx tinstar`, so an operator can upgrade without ever seeing a release note — and the symptom (a URL that stopped answering) looks like a crash rather than a decision. The server therefore prints this change **once**, on the first start after upgrading an existing install. A brand-new install stays quiet: it never had the old behaviour.

Code: `src/server/bind.ts` (the bind resolver and the one loopback literal), `src/server/bindNotice.ts` (the one-time notice), `src/server/standalone.ts` (listener wiring), `src/server/sessions/backends/tmux.ts` (terminal bind, incumbent bind matching, the readiness probe's header), `src/server/sessionProxy.ts` (the terminal auth header, origin refusal, identity-header stripping), `bin/tinstar/commands/reach.js`, `bin/tinstar/reachGrant.js`.

---

## ⚠️ Breaking change — Initiative, Epic, and Task are gone

The sidebar taxonomy is now **Project** and **Worktree**. Initiative, Epic, and Task are removed, and there is no migration: that hierarchy was unused in practice, and sessions can be recreated. A Worktree always belongs to one Project. A widget with neither is Unscoped.

Scope is a label for organization, not a filter. Changing it does not move widgets and does not change what a widget shows. The hierarchy updates live. The canvas updates when you run **Organize**, which packs the current scope into Project and Worktree containers and leaves Unscoped widgets as peers. Snapped constellations stay snapped.

NATS subjects follow the same shape: `tinstar.<space>.<project>.<worktree>` for the worktree broadcast, plus `.<session>` for a direct inbox. See [docs/nats-agent-channels.md](nats-agent-channels.md).

Code: `src/components/WorkspaceShell.tsx`, `src/components/HierarchySidebar.tsx`, `CONCEPTS.md` (Organizational scope, Organize), `docs/plans/2026-08-07-001-feat-project-worktree-scope-plan.md`.

---

## The Slate — the board on the card

**A headline of v5.4.** A run's transcript stays available, but the thing you act on lives on the **Slate**: a region of that run's workspace card. An agent, you, or a local process writes a small surface there — an open question, a diagram, a form, a progress card. Roundup is still the cross-run notice board. The Slate is what is going on inside *this* run. Living guide: [docs/the-slate.md](the-slate.md). Product behavior for live sessions: [docs/features/slate-first-live-authoring.md](features/slate-first-live-authoring.md).

### What a surface is

- **File in, HTTP out.** The body is a JSON file in `<worktree>/.tinstar/slate/`. The watcher validates it and projects it onto the run. When you answer, the browser POSTs to a run-scoped endpoint, the store keeps the thread, and the server injects a prompt so the agent hears you. A rewrite amends the body and does not clobber a reply you just typed.
- **Addressable points.** Each item has a headline, a stable id, an append-only thread, and a soft lifecycle. Identity is the id inside the file, not the filename.
- **The Objective.** Creating a session with a prompt also pins that trimmed text as the run's Objective, drawn optimistically before provisioning finishes. Persona text and host introductions never become the Objective. Apply persists an edit and nudges the agent; typing alone does not.
- **A workbench.** Related non-decision questions that share a `group` render side by side, one per column.
- **A Decision card.** One call, with its risks, what it costs to reverse, and the horizon. An unanswered Decision has no refresh recipe: reading it must not launch an agent.
- **Diagrams and phases.** A2UI gains `Mermaid` (a themed diagram) and `Stepper` (a status-colored phase track). The catalog still includes the layout and prose primitives from Roundup.
- **Authoring manners.** "Add surface" creates a durable card. "Explain the session" drafts one from the run. "Clean the slate" is a confirmed wipe. Freshness reads as "updated Xm ago", with a stale cue. Code-spawned authors can write a surface without a person pasting JSON, and that path is kill-switchable.

### What keeps it honest

- **Canonical store.** A Surface is a stored object with revision-safe mutation, recoverable deletion, and the same writes for an agent and the UI. `Run.slate` is derived from that store. Crash-safe sidecar, re-entrant migration off the older shape.
- **Claims and witnesses.** A surface can declare what would prove it wrong. A separate witness can say whether a plan unit has landed, from a `Plan:` trailer on the squash commit — it does not guess.
- **Trusted refresh.** A commit can mark a surface dirty. Only a person runs the refresh. Selecting or reading a card does not prompt an agent. An explicit refresh control is the only path that does. Full-width work and ordinary reflow are presentation, not a refresh.
- **Measured masonry ([ADR 0003](adrs/0003-slate-masonry-reflow.md)).** One column below 420px, two from 420 through 699, three at 700 and wider. Each card is measured and packed into the earliest column, so a tall card does not leave an empty block beside it. Order in the document stays the keyboard order. Width is the only layout preference that is saved. Coordinates are derived and never written back.
- **Slate-first sessions.** The transcript is supporting history. A surface earns its place when you asked for it, when you must act, when it is the result you judge the Objective by, or when something is blocked. Raw logs, tool dumps, and turn receipts stay in the transcript.

Code: `src/components/RunWorkspaceWidget/SlatePanel.tsx`, `slateMasonry.tsx`, `src/server/api/surfaceRoutes.ts`, `src/server/sessions/surfaceAuthor.ts`, `src/a2ui/` (`catalog.tsx`, `controls.ts`, `controlComponents.tsx`), `agent-skills/skills/slate-surface/SKILL.md`, `docs/slate-design-language.md`.

---

## Focus mode — one session, the whole pane

Focus mode fills the canvas with one run workspace instead of the infinite board. You still cycle to the next session that is ready for input: `Ctrl+[` / `Ctrl+]`, and, while Focus is active, the mouse Back and Forward thumb buttons. The gesture is consumed so the browser does not navigate history. Canvas mode is unchanged. Cycling does not resize the terminal; the geometry stays put so the pane does not reflow under the agent. A cycled workspace that had been hidden is revealed.

Code: `src/components/FocusModeToggle.tsx`, `src/components/InfiniteCanvas.tsx`, `src/components/RunWorkspaceWidget/focusLayout.ts`, `docs/features/hotkey-system.md`, `docs/solutions/ui-bugs/focus-mode-terminal-reflow-when-switching-run-workspaces.md`.

---

## Delivery — a sent prompt has a receipt

Steering Claude or Codex from Tinstar is a **delivery**: accepted, routed, confirmed against the provider's own record, and recoverable when the confirmation is late. A ledger on disk holds the obligation until it reaches a terminal state. The router publishes over NATS. Recipient resolution is live, so a message is not accepted for a session that cannot be addressed. Codex confirmation reads the rollout schema (including Codex 0.147). A native Codex child router no longer collides with Tinstar's. Hand message delivery is isolated, so one hand does not receive another hand's prompt.

Code: `src/server/messaging/delivery-ledger.ts`, `src/server/messaging/` (router, recovery, provider adapters), `docs/nats-agent-channels.md`.

---

## Time, quota, and workers you do not own

### Where the run's time went

The rail can show a **timeline** of the session: approval (you are the blocker), question, idle, tool, think, subagent, compact. A percent mode shows the same bands as shares. The help on the control names the columns in plain words. Timestamps for Codex come from the observed time in its OpenTelemetry stream, not from a clock Tinstar invents.

Code: `src/components/Telemetry/TimelineStrip.tsx`, `src/components/RunWorkspaceWidget/TimelinePanel.tsx`, `src/server/sessions/timeline/`, `src/hooks/useSessionTimeline.ts`.

### Provider quota and token history

Claude and Codex observations land in provider stores: usage, quota windows, and context size. The quota visuals survive a reload. Token history prefers a fresh cumulative total and does not double-count a legacy total beside it.

Code: `src/server/observability/`, provider observation stores and the quota UI on the run workspace.

### First mate, as cards only

If you list a first mate home in config, Tinstar follows that home's fleet ledger and shows one **observed run** per worker. Tinstar does not spawn, stop, or steer it. Deleting the card dismisses it. The card can host a live typeable terminal on the worker's existing tmux window, via a private `tsview-*` session that links the window and never owns it. A heuristic links the card to the worker's Claude conversation so the status light, recap, and timeline have something to read; you can override the link. With no homes configured, the observer never starts.

Not in this release: a prompt composer on the card, starting or stopping workers from Tinstar, or cost and token totals for those workers.

Code: `src/server/firstmate/`, `src/plugins/firstmate/`, `docs/features/firstmate-observer.md`, `CONCEPTS.md` (Observed run).

---

## Agents and the tools around them

- **Grok as a provider.** A `grok-full-auto` CLI template launches `grok --always-approve` with a session id, and resumes the same way. Instructions install through Grok's rules mechanism.
- **Statusline hook, installed.** Onboarding installs the Claude statusline hook instead of assuming it is already there. `tinstar doctor` and preflight also check that `bun` is on `PATH`.
- **tidy-repo.** An agent skill walks open pull requests one at a time: brief, land within the repo's merge policy, prune branches that are already merged, and sync the default branch. It does not ship uncommitted local work.
- **CLI templates.** Stale name references in the default roster are repaired, and edits still hot-reload.

Code: `src/server/sessions/config.ts` (the `grok` template), `src/server/providers/lifecycle.ts`, `agent-skills/skills/tidy-repo/SKILL.md`, `bin/doctor.js`.

---

## Reliability and polish

- **Guest environment.** Tinstar's own startup environment no longer leaks into a guest session. A worktree that already has `.claude` is not re-copied. A blocked worktree branch name returns a clean 409 and leaves the create dialog open.
- **Session start.** One slow `lsof` probe no longer pauses every session start. New workspaces launch optimistically, and a new session packs into free canvas space instead of drifting right. tmux sessions are targeted by exact name. The per-session NATS channel server is reaped on stop, delete, and start.
- **Inbox and recap.** Hidden sessions stay out of the inbox. The recap shows the live prompt and turn progress. Recap length, composer render scope, and recovery retention are bounded so a long fleet stays responsive.
- **Projects.** A project path that does not exist is rejected.
- **Slate answers stick.** An answered point stays answered across both surfaces. Point identity is per run, so the same id in two runs does not collide. The point-key joiner is an escaped NUL, not a raw NUL byte. An expanded Mermaid diagram sizes to its content.

Code: `src/server/sessions/`, `src/components/optimisticSession.ts`, `src/server/api/routes.ts`, `docs/solutions/`.
