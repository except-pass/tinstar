---
date: 2026-09-24
topic: tinstar-v6
---

# Tin Star V6 requirements

## Summary

Tin Star is First Mate's visual dashboard and interaction layer. First Mate owns execution, worker lifecycle, and durable user intent. This contract describes the intended product and acceptance requirements; the staged release plan is in [the V6 cockpit plan](../plans/2026-09-28-001-feat-v6-cockpit-plan.md).

---

## 1. Core requirements

| ID | Contract |
|---|---|
| R01 | First Mate owns worker creation, worktrees, dispatch, supervision, runtime organization, and worker lifecycle. Tin Star is its visualization and interaction layer, not a second orchestrator. |
| R02 | Every canonical user-originated change goes through a durable First Mate-owned command/intake boundary. Tin Star does not edit authoritative records behind First Mate's back. |
| R03 | Organization is optional. A user can launch an isolated session without creating an initiative, epic, or Stretch Plan; an epic can exist without an initiative. When relationships are present, they must be real and consistent. |
| R04 | The planning hierarchy is Initiative → Epic → Task. Projects/repositories are an orthogonal dimension. Each implementation task belongs to exactly one project. |
| R05 | Stretch Plan already does the planning job well. Use it at epic scope, normally one plan per epic, with multiple executable tasks and rich context. Do not redesign it merely to reconcile earlier terminology. |
| R06 | Plans have wall-clock-hour schedules. Material schedule drift raises a Needs You item while execution continues. No silent multi-day churning, and no automatic stop solely because a time budget was exceeded. |
| R07 | One Needs You queue, six strict subtypes, consistent rendering within each subtype, distinct appearance across subtypes, and a useful action on every compact card. |
| R08 | Navigation is direct and link-based. The data can be hierarchical without making users traverse the hierarchy. No infinite canvas or mandatory zoom ladder. |
| R09 | Keep Tin Star's cyberpunk-cowboy identity, recognizable worker faces/colors/names, visible project/worktree context, compact quota meters, and rapid bracket-key session cycling. |
| R10 | Context Threads let the user point at an object, selection, or part of a surface and discuss that thing in place. All such conversations go to First Mate in V1. |
| R11 | Each worker has one current, explicit Objective. It belongs to the worker, not to an arbitrary UI surface. |
| R12 | First Mate's general conversation remains outside Tin Star, preferably in the user's native desktop assistant. Worker terminals are views inside Tin Star. Do not confuse the two. |
| R13 | Tin Star adapts to First Mate's actual runtime topology. It must not impose Tin Star V5's tmux naming, session, window, or worktree assumptions. |
| R14 | A ground-up Tin Star rewrite is permitted. Preserving V5 architecture is not a requirement; preserving the explicitly valued product behaviors is. |

---

## 2. Product goal and scope

### The desired way of working

The user works with First Mate as a chief of staff. First Mate knows the work and routes it, rather than trying to hold every detail of twenty repositories in one conversation. For substantial work, it creates a context-rich design worker that can inspect the relevant projects and work interactively with the user. The resulting design and implementation instructions are organized into a Stretch Plan. Once authorized, First Mate runs the work, supervises workers, and returns exceptions and review requests to the user.

Tin Star makes that work visible and actionable without requiring the user to reconstruct it from terminal scrollback. The user should be able to look away confidently, return, immediately recognize the workers and workstreams, and handle the things that need judgment.

An example portfolio:

```text
Initiative: Keystone Designer relaunch
  Epic: Solver
    Stretch Plan → project-local tasks
  Epic: Tariff engine
    Stretch Plan → project-local tasks
  Epic: Calculator engine
    Stretch Plan → project-local tasks
  Epic: Data Rivers integration / release
    Stretch Plan → project-local tasks
```

These streams need coordination even before strict dependencies exist. Shared initiative membership communicates that relationship; do not manufacture blocking dependencies just to express related work. When Data Rivers V0.1 must land before another stream can use it, represent that specific dependency explicitly.

### Rewrite posture

V6 may be a new application architecture, a major refactor, or a selective rewrite. Existing code is a source of useful implementation and hard-earned lessons, not a constraint on the product. Reuse proven terminal-view, quota, identity, and integration code when helpful. Do not rebuild those mechanisms gratuitously, and do not drag the canvas/plugin architecture into V6 solely because it already exists.

Permission to rewrite source code is **not** permission to erase First Mate data, remove running workers, discard unmerged work, or replace a working installation without a recovery path. Develop in isolated worktrees and preserve the user's current working environment.

### V1 boundaries

V1 is local, single-user software. It includes portfolio organization, Stretch Plan integration, worker visibility, terminal attachment, Needs You, Context Threads, and a lightweight launch path, all integrated with First Mate.

Out of scope: remote worker machines, multi-user collaboration, an infinite canvas, arbitrary panel arrangement, a new agent harness or scheduler, a replacement general-purpose chat app, a generic workflow builder, a new plugin ecosystem, and rebuilding GitHub's pull-request review UI. Supporting every First Mate runtime backend immediately is also unnecessary; local tmux-backed workers are the initial terminal target.

---

## 3. Domain model and optional organization

### Entities and relationships

| Entity | Meaning and constraints |
|---|---|
| Initiative | Durable grouping of related epics and outcomes. Can coordinate multiple projects and workstreams. |
| Epic | A meaningful workstream/outcome. May belong to one initiative or stand alone. Usually has one Stretch Plan; a small number is allowed. Can span multiple projects. |
| Stretch Plan | Relatively ephemeral execution roadmap and context container for an epic, usually containing roughly 5–50 tasks. Preserve its existing useful representation and authoring workflow. |
| Task | A planned unit of executable work. Each implementation task belongs to one project. Tasks in a plan must be linked unambiguously to that plan and epic. Dependencies may cross projects and epics. |
| Project | A repository and its relevant configuration. Not a parent in the initiative hierarchy. |
| Worker | A First Mate-managed agent session/worker identity. Works on at most one assigned task at a time, or on a standalone objective. Runtime attempts and resumptions remain First Mate's concern. |
| Worktree | A project-local execution checkout managed by First Mate. Tin Star displays it; it does not allocate or reclaim it independently. |
| Objective | One current statement of what a particular worker is trying to accomplish. Durable and addressable. |
| Needs You item | A durable, typed request for human attention with provenance, a response/resolution lifecycle, and fixed presentation. |
| Context Thread | A durable conversation anchored to one or more identifiable objects or parts of a surface. Its V1 recipient is First Mate. |
| Output | A PR, commit, report, design artifact, or other result, linked back to the relevant task/worker and plan when applicable. |

```text
Initiative ──contains──► Epic ──has──► Stretch Plan ──contains──► Task
                         │                                    │
                   may stand alone                      exactly one Project
                                                              │
                                                         Worker(s over time)
                                                              │
                                                   First Mate-managed Worktree

Standalone session ──► Worker + Project + Objective
                       No initiative/epic/plan ceremony required
```

### Optional does not mean ambiguous

A user may launch a worker with only a project and objective. A user may create an epic without an initiative. Attaching work to an existing task is optional, but once attached the task, plan, epic, and initiative relationships that actually exist must be persisted correctly. Never rely on a matching title, terminal name, or a sentence in chat as the only association.

If First Mate internally requires a task/backlog record to launch a worker, create or use that record through its normal behavior. “Standalone” is a user-experience property, not permission to bypass First Mate's internal requirements. Do not require the user to invent a fake initiative or epic to satisfy storage constraints.

Use stable identifiers and authoritative relationships. Names are labels. A task's project must agree with its execution worktree. A runtime generation must not be confused with a different worker because an endpoint name was reused. A missing relationship is valid where optional; a contradictory relationship is not.

Later organization of standalone work should be possible without restarting the worker. An implementation may derive ancestor links rather than duplicating them, provided all relevant views and commands resolve the same relationships.

### Design workers

A design worker operates at epic/problem scope and may need context from several repositories. Its deliverable is the design/implementation material and the Stretch Plan, not necessarily code changes. It can be interactive with the user through First Mate's routing.

This is a role distinction, not a mandate to invent a new First Mate lifecycle or task-kind enum. Map it onto supported First Mate mechanisms where possible. Identify where the design artifacts are written; keep repository inspection and artifact-write authority explicit. Cross-repository reasoning is allowed; the implementation plan still decomposes code changes into project-local tasks.

---

## 4. Authority, storage, and durable changes

### Who owns what

First Mate owns execution and the authoritative handling of user intent. Portfolio records, configured columns, work associations, objectives, attention objects, and Context Threads live in simple durable local storage under a First Mate-owned boundary, outside any requirement to put all portfolio state in one project repository.

Files in First Mate's existing data area or SQLite are both acceptable. There is no need for a cloud service, distributed database, or multi-user permissions model. The planning agent chooses the smallest safe implementation.

Stretch Plan remains authoritative for its plan representation and task schedule through its supported interfaces. First Mate coordinates its use and derives execution facts from its existing runtime and forge mechanisms. Tin Star must not introduce another independently authoritative task-status or scheduling database. Use associations/projections where multiple existing stores participate.

Tin Star may own presentation-only preferences and caches: selected view, scroll position, collapsed sections, theme settings, and pending visual state. Navigation, opening a link, or collapsing a panel does not need a First Mate model turn.

### Mutation flow

```text
User changes something in Tin Star
  → Tin Star submits an explicit, attributable intent
  → First Mate-owned intake durably records it
  → First Mate applies or delegates the authorized change
  → Receipt/result and authoritative state become available
  → Tin Star reconciles its presentation
```

This applies to card moves, column edits, objective edits, hierarchy changes, launch requests, Needs You responses, Context Thread messages, and edits made through an integrated Stretch Plan surface. Embedding the old planner must not silently restore a direct-write bypass. Reuse its mechanics, but route V6-originated mutations through the agreed authority boundary.

The mechanics need not force the model to reason over every trivial write. A deterministic First Mate-owned helper can apply an authorized change and record/notify it. The invariant is coherent ownership and durable intent, not needless model latency.

### Delivery guarantees

Every submitted mutation needs a stable request identity and a retrievable receipt. A retry must not launch a second worker, repeat an approval, or duplicate a card move. Distinguish queued, acknowledged, applied, and failed states as needed; “saved to the inbox” does not mean “the action completed.”

Optimistic UI is acceptable. A card can animate immediately, but its pending status remains visible until the canonical result arrives. A failed or stale command must be explained and reconciled. Never leave a visually successful move that was not committed.

Preserve ordering or detect conflicts when the same object is edited repeatedly. Responding to an old set of decision options must not authorize a changed proposal. The exact revision/transaction mechanism is an implementation choice; preventing silent lost updates and duplicate actions is not.

Manual action is explicit user intent. First Mate should not immediately undo it because it contradicts an older inference. If it conflicts with recorded instructions or real execution state, surface that conflict rather than silently pretending neither happened.

### Existing intake to build on

First Mate already has an out-of-band primary inbox. Its inspected `fm-inbox.sh` supports idempotent `note --request-id`, announcement repair, durable replies, receipts, and a primary-readiness projection. Use that as the first integration candidate. Its `ask` subcommand is a separate side-model question path, not delivery to First Mate; it is therefore not the V1 Context Thread route. [S4]

Worker steering and primary intake are different directions. Existing worker steering helpers are not automatically a general UI-to-primary command bus. A wrapper may add typed intent and thread correlation, but it must use or extend First Mate's supported contracts rather than silently writing private files.

---

## 5. Planning, execution, and schedule accountability

### Preserve the working planning pattern

The intended workflow is optional brainstorming, planning, then execution. Use EveryInc's Compound Engineering skills and Stretch Plan's existing skills where appropriate. The planning output includes a design/product specification, an implementation specification, and a Stretch Plan that links to the relevant instructions. Reuse this settled product contract; do not restart the entire brainstorm or re-ask decisions already answered here. Add repository-grounded detail only where needed.

These are logical deliverables, not a requirement to split an existing combined artifact into two physical files. The inspected Stretch Plan planning skill already calls Compound Engineering and recognizes an implementation-ready unified plan containing product, planning, implementation, verification, and completion material. [S6]

An epic-level Stretch Plan with many board tasks can coexist with a linked implementation-plan file per board task. Do not confuse a whole Stretch Plan, one board task, and one implementation-plan document. The earlier suggestion that Stretch Plan necessarily needed a fundamental semantic rewrite is superseded: **the user already likes how Stretch Plan works.**

Readiness is the user's judgment, informed by an executable plan and the existing tools. Do not add a new mandatory checklist bureaucracy beyond what the selected workflow already requires. An explicit approval or standing instruction can authorize execution. Moving a card into a column is not automatically merge authority or permission to bypass an existing gate.

### Integrate execution; do not replace it

The inspected `work-the-plan` skill currently dispatches and steers through Tin Star-specific machinery. Adapt that path to First Mate ownership before using it in V6. Reuse its useful planning, evidence, and reconciliation ideas, but do not invoke the old Tin Star spawn path or replace First Mate's merge/lifecycle policies with the old skill's policies. [S7]

First Mate continues to decide dispatch, concurrency, retries, worktree handling, model/runtime selection, recovery, and cleanup under its existing configuration. V6 must not introduce a second scheduler or a competing quota-based router.

Dependency completion must mean the necessary output is actually available to the dependent task under the selected delivery policy. A worker saying “done,” an open PR, passing CI, and merged/available code are not interchangeable. Preserve First Mate's evidence and authorization distinctions.

### Wall-clock schedule

A Stretch Plan must express its execution schedule in wall-clock hours, not developer-days, story points, or token budgets. Show dependencies and expected parallelism, so a plan's total elapsed duration is not confused with the sum of all task durations.

Stretch Plan already supports hour-labeled slots, but its documented `unit` is a display/slot convention, not a running deadline-enforcement engine. V6's schedule accountability needs real baseline and observation semantics, not merely `unit: hr`. [S5]

The implementation plan must define:

- The schedule's start anchor and each task's planned interval/budget, using Stretch Plan's actual slot semantics.
- Actual start, completion, and elapsed wall time where observable; task time across retries must not silently reset to zero.
- Planned-versus-actual drift, including late starts and downstream impact where known.
- Waiting on a dependency, human, CI, or quota as an explanation of elapsed time, not hidden removal of wall-clock delay.
- A visible distinction between an original agreed schedule and any later forecast or authorized replan.

The exact material-drift threshold is an engineering default to propose and document, not a settled numeric value. Avoid alerting on trivial jitter and avoid silently allowing multiples of the agreed budget. If the estimate is wrong, report and revise honestly; do not skip validation to make the display look on time.

### Overrun behavior

**Continue working and escalate to the user.** First Mate raises a non-blocking Schedule Drift item in the same Needs You queue. Include the planned versus elapsed duration, current activity, and evidence of real progress. Coalesce repeated observations of the same overrun rather than creating a new card every poll.

A schedule overrun alone does not stop or kill a worker. Existing safety, authorization, and failure policies still apply independently. Acknowledging drift is not silently approving an unlimited extension or rewriting the baseline. Explicitly choosing to revise a budget is a separate, recorded user intent.

---
## 6. Application shell and navigation

### Two-pane Tin Star, separate First Mate conversation

```text
┌────────────────────────┬──────────────────────────────────────────┐
│ Persistent rail        │ Main focus area                          │
│                        │                                          │
│ Needs You              │ Portfolio / Epic + Stretch Plan / Task / │
│ Worker identities      │ Worker / Worker Terminal                 │
│                        │                                          │
│ Compact quota meters   │ One selected presentation at a time      │
└────────────────────────┴──────────────────────────────────────────┘

Separate native assistant window: general conversation with First Mate
```

Keep attention and quota information accessible while moving between work views. This is not the earlier three-pane proposal with a permanently selected worker terminal. The permanent conversation is with First Mate and may live in another application. A worker's terminal is something the user navigates to in Tin Star.

Do not build an embedded general-purpose chat replacement. Context Threads are allowed and required because they are anchored conversations, not an unrelated chat pane. The native desktop integration needs the verification in Section 12; choosing two windows does not by itself prove the entire First Mate supervisor can run inside a native chat session.

### Presentations, not a navigation ladder

| View | Primary purpose |
|---|---|
| Portfolio | Organize and scan initiatives/epics on a configurable Kanban board. No task-level Kanban requirement. |
| Epic / Stretch Plan | See the workstream's goal, design context, linked plan(s), task schedule, dependencies, progress, workers, and attention items. |
| Task | Inspect the task's instructions, project, plan relationships, dependencies, acceptance criteria, execution, outputs, and related conversations. |
| Worker | Recognize the worker and its objective, project/worktree, activity, output, and available supporting evidence. |
| Worker Terminal | Interact with the actual First Mate-managed worker endpoint through an attached view. |

A worker's terminal may be a mode of its worker presentation rather than a wholly separate route. Exact routing and component decomposition are engineering choices. Users must be able to go directly to the thing they want.

A terminal-to-portfolio jump must not visit worker, task, and epic screens in sequence. A Needs You item can open its associated task, comparison, or PR directly. Contextual ancestor links remain useful; breadcrumbs are permitted, not a mandatory traversal path. Back/Forward should return to actual browsing history, not simulate moving up or down the hierarchy.

Give the user a persistent way to reach the board and a fast way to select workers. Direct First Mate-requested focus/navigation actions should use the same navigation mechanism. Ordinary background state updates must not steal focus or yank the user into another view.

### Motion

Keep the game-like feeling and satisfying transitions. The corrected metaphor is a quick contextual jump or “hyperspace” transition, not manipulating a continuous map camera. Preserve the selected object's identity through motion where useful.

Navigation must remain interruptible and fast. Never require an animation to finish before accepting the next worker-switch command. Respect reduced-motion preferences. Exact effects, easing curves, and durations are implementation discretion; the effect must serve orientation, not consume attention.

### Keyboard worker cycling

Rapid previous/next worker cycling is a core requirement, not a polish task. Preserve the familiar **Control + square-bracket** interaction, including reliable operation when the terminal or composer has focus. Cycling must cover all workers rather than a hidden “ready only” subset. The planning agent should verify the existing bindings and choose a clear all-worker path without importing an entire unused hotkey vocabulary.

Use a stable, understandable cycling order. Switching should preserve the worker/terminal mode where appropriate, retain useful per-worker view state, and immediately show the next worker's identity. Repeated switching must not restart workers, duplicate terminals, lose input drafts, or reflow terminal buffers merely because the selected worker changed. Real viewport resizing is a separate event.

Do not make ordinary scroll-wheel gestures unexpectedly change the selected worker. Supply visible navigation controls as well as keyboard access.

---

## 7. Portfolio, epics, and retention

### Configurable Kanban

Columns have a stable identity, a **name**, a **description**, and an order. The description communicates how the user intends the workflow to operate; First Mate can use it to reason about card movement. Do not hard-code a universal Backlog → Designing → Ready → Executing → Review → Done lifecycle into the board.

Different users may want different processes. Initial example columns are acceptable as editable defaults, not semantics buried in application code. If a description changes, First Mate must learn that intentional change through the durable boundary.

First Mate can move cards. Users can drag cards, reorder them, and edit the board through the same authoritative path. These are not independent competing writers. A column change is organizational state; it must not silently cause an execution or merge action unless the user's explicit workflow instructions authorize that behavior.

The default portfolio unit is an epic. Initiatives group or coordinate epics, with support for ungrouped epics. Initiative swimlanes are a reasonable presentation suggestion, not a mandated layout. The portfolio can summarize initiative status without requiring initiative and epic cards to be peers.

### Epic-card taste

Aim for the density and familiarity of Jira or Notion: compact, readable, and easy to scan across many cards. Keep the title prominent and the useful signals stable. Relevant secondary information can include active worker identities, Needs You count, task progress, and a linked Stretch Plan.

Do not fill each card with a miniature dashboard. Clicking a card opens the epic. Exact styling, secondary metadata, grouping layout, and proportions are intentionally not product blockers and may change after use.

The Kanban package choice is not a requirement. **Atlassian Pragmatic Drag and Drop is a suggested starting point only.** The planning agent should assess current options and may recommend another package. Borrow mechanics without surrendering Tin Star's domain model or visual identity.

### Completed work

First Mate continues to handle worker lifecycle and cleanup as it does today. Do not introduce a competing retirement timer or a new worker archive policy in Tin Star.

Completed epics remain visible for approximately one week, then leave the active board. Implement this as archival/hiding, not destructive deletion of the work record or its useful links. A completed Stretch Plan can remain available as historical evidence without being maintained as a live dashboard. Archiving an epic must not erase its Context Threads or silently resolve outstanding Needs You items.

Do not detect completion by matching a literal column name such as `Done`. Record completion through First Mate's interpretation of the configured workflow or an explicit user action, then use that completion time for aging. Browsing an epic should not restart the retention clock. Reopening it makes it active again. The precise storage/sweep implementation is for the planning agent.

---

## 8. Worker identity, Objective, and launching

### Preserve the visual recognition system

Each worker has a recognizable identity: **name, face/avatar, and identity color**. The project and worktree are consistently easy to find. Use this identity in the worker rail, worker/terminal header, task execution badges, attention provenance, and anchored conversations. Outputs should link back to their originating work without adding unwanted attribution text to commits or PRs.

Identity belongs to the worker, not to the pane. It must not change merely because the user navigates, refreshes, or reopens an attached view. Persist a visual identity or derive it from a genuinely stable identifier, never from list position or a transient port.

Keep runtime generations and resumptions traceable. Preserve recognition when the same logical worker resumes, and do not silently conflate a genuinely different worker with an earlier execution. Exact generation labeling is a planning decision; do not replace First Mate's lifecycle to implement visual identity.

Identity color is not status color. Use separate labeled indicators for working, blocked, unknown, and other observed states. Color alone must not carry identity, type, or status. Consistent face/name placement is essential.

### One worker, one current Objective

Every worker carries one explicit current Objective, visible in its worker presentation and available through an addressable interface. This is the touchstone that tells both the user and the agent what the worker is trying to accomplish.

For an attached worker, derive the Objective from its task. It may be narrower for that particular assignment, but must not silently replace the task's acceptance criteria. Completing a narrower worker objective does not automatically complete the parent task. For a standalone worker, the initial user intent supplies the Objective.

First Mate may revise an Objective in accordance with user instructions. Persist and expose meaningful changes; do not let it drift invisibly. Keep the user goal distinct from launch boilerplate, persona text, or machinery instructions.

Support a contextual instruction to pursue the current Objective without making the user retype it. Resolve the worker and its current Objective, then deliver that instruction through First Mate. The exact command spelling is an implementation choice.

Do not create an Objective object for every UI surface. The ownership requirement is specifically one current Objective per worker.

### Minimal launch path

The normal launch needs only a project and an objective, with a friendly session name available and preferably suggested. First Mate handles the worktree, harness/model defaults, execution profile, isolation, and worker registration as it already does. Advanced overrides may be available, but no new routing-policy UI is required.

Launching from a task prepopulates the task/project/plan context and persists the association. Launching from elsewhere can create standalone work or attach to an existing task without forcing the user through extra hierarchy screens.

A pending launch remains visibly pending until First Mate confirms it. Repeated submission or a network retry must not create duplicate workers. Failure must remain inspectable with the submitted objective and reason, not vanish.

---

## 9. Needs You: one queue, strict types

### Presentation contract

Use a single queue for decisions, blockers, failures, schedule drift, contradictions, and review requests. Do not split review into a quieter second queue. Items can differ in urgency and whether work can continue; that does not change the one-queue decision.

**Same subtype, same shape every time. Different subtype, recognizable before reading the details.** Tin Star owns the renderers. Agents provide validated data; they do not invent card layouts, compose arbitrary A2UI trees, or generate custom HTML for each request.

Each compact rail card contains the headline, relevant origin, a few subtype-specific facts, and a useful action. Expanded presentation is optional by subtype. Opening details must not force the user away from their current work context; a modal, drawer, or anchored detail panel is acceptable. Preserve a clear return path.

A compact decision can be answered immediately when the user already understands it. A complicated decision can expand to the full treatment. A PR card links to GitHub; it does not require a Tin Star modal as an intermediate stop.

### Common logical envelope

The following names describe semantics; wire-format spelling and validation-library choice are implementation details.

| Field | Meaning |
|---|---|
| Stable ID and type | Identity and one of the six V1 subtypes. |
| Headline | A concise statement of what needs attention. |
| State | At minimum, distinguish open, answered, and resolved. Receipt/delivery status is separate from business resolution. |
| Provenance | Relevant epic, plan, task, worker, source, and evidence links. Omit nonexistent ancestors for standalone work. |
| Created/updated times and revision | Age, meaningful changes, and safe response to the version the user saw. |
| Execution impact | Whether relevant work continues or is blocked; represent unknown/not-applicable honestly when needed. |
| Typed payload | The subtype-specific information below. |
| Response/resolution | Who answered, what they authorized or supplied, when, and what First Mate did with it. |

Persistence matters: a session ending must not erase an open decision or its answer. An answer is not “resolved” merely because it was queued for a worker. Clicking an external link is not approval, merge, or resolution. Repeated event observations update the same logical item rather than flooding the rail.

Strict schemas must not require invented facts. Use explicit unknown/unavailable values or reasons when evidence cannot be obtained. Reject or visibly diagnose malformed producer data; do not silently make an incomplete decision look safe. A renderer must never turn unknown risk into the lowest risk category.

### The six renderers

| Type | Compact information | Primary action | Expanded information |
|---|---|---|---|
| Decision | Headline, option labels, origin, salient risk/horizon cue. | Choose an option; inspect details; comment. | Background, tradeoffs, risk dimensions, reversal, horizon, supporting context. |
| Blocked | What is needed, why work is blocked, affected worker/task. | Supply the requested information/action or open its context. | Attempts already made, exact unblock condition, affected and independently continuing work. |
| Failure | What failed, immediate impact, recovery already attempted/current recovery state. | Inspect; request a valid recovery action through First Mate. | Error evidence, attempts, scope of impact, proposed next action. |
| Schedule Drift | Planned versus elapsed wall time, overrun, worker/activity, continuing-state label. | Inspect/steer; acknowledge the escalation. | Baseline, observed progress, last meaningful progress, explanation, downstream effect. |
| Contradiction | The two conflicting claims, summarized consistently. | Compare. | Side-by-side claims and evidence, provenance, impact, requested judgment. |
| Review Ready | What is ready and where to review it. For a PR: headline, repo, PR number, link. | Open the authoritative review target. | Optional; only when Tin Star has useful additional context. |

Each renderer needs a distinct fixed icon, layout, and action pattern. Accent treatment can reinforce type; it must not replace text/icon distinctions or fight worker identity color. Avoid decorative variation between two cards of the same subtype.

### Decision payload — preserve the rich Slate treatment

This is a carry-forward product requirement. The inspected V5 implementation contains the option fields and scales below. Preserve their semantics, not necessarily its A2UI dependency or old Slate layout. [S1]

**Background and context:** What is being decided, why it is being asked now, relevant constraints, and links/evidence. These must be understandable without reconstructing a transcript.

**Options:** At least two meaningful alternatives with stable option IDs. Each has `label`, `gain`, `cost`, and `wrongIf`. Cost must name a concrete loss, not “adds complexity.” `wrongIf` names the condition that would change the choice.

**Risks:** Each risk has a label, severity, likelihood, discoverability, and an explanatory note where needed.

```text
severity:        annoying | costly | severe
likelihood:      unlikely | possible | likely
discoverability: obvious | subtle | silent

reversal.action: trivial | cheap | costly | one-way
reversal.damage: minutes | hours | days | weeks+

horizon.span:    until-next-commit | until-this-ships |
                 while-the-code-lives | permanent
horizon.until:   the concrete condition that ends its relevance
```

Reversal of the action and recovery from its damage are different questions. A revert can be cheap while consequences persist. Horizon is also distinct from either. Preserve the explanatory reversal note and the always-available comment affordance.

No composite risk score. These dimensions must remain individually legible. Do not multiply ordinal labels into a fake precision number.

On the compact card, show usable option actions and an obvious way to inspect all details. Do not crowd every risk table onto the rail. Do not silently hide the existence of additional options when only a bounded number fits. A changed decision invalidates an old unsubmitted choice or requires explicit reconciliation before applying it.

### Blocked and Failure payloads

Blocked requires the exact missing information/action, reason, attempts made, and impact. Distinguish “choose between alternatives” from “provide this missing thing.” Put secret-bearing actions behind the appropriate secure mechanism rather than inviting credentials into a general thread.

Failure requires the failed operation, error summary and evidence, attempts at recovery, affected work, and a proposed valid next action. A retry button must call First Mate's control/decision path; it must not implement its own process restart. A failure does not automatically mean the whole epic is blocked.

### Schedule Drift payload

Carry the planned interval/budget, actual elapsed wall time, current activity, last meaningful progress where known, progress evidence, and an explanation if available. Mark observations and estimates distinctly. “Last meaningful progress unknown” is better than pretending terminal output is proof of progress.

Acknowledge/inspect/steer are reasonable compact actions. Re-budgeting or canceling work is an explicit separate instruction. The default for schedule drift remains **continue + escalate**, not pause.

### Contradiction payload

Show claim A and evidence A beside claim B and evidence B, each with its source. Explain the consequence of the disagreement. Contradictions may be blocking or non-blocking depending on the work; do not hard-code that every contradiction stops execution or always permits it to continue.

### Review Ready payload

Use a review-kind discriminator for PR, plan/design review, report, or another supported artifact. Include a concise summary, target, validation performed, and important unvalidated items where relevant. Do not present unknown CI state as green.

For a PR, the indispensable compact fields are **headline, repository, PR number, and a direct PR link**. A CI summary is useful when known. GitHub is the review interface. No mandatory modal and no requirement to build an in-app merge/review system. First Mate's existing policies decide how a real merge is authorized and observed.

---

## 10. Context Threads: talk about the thing being shown

The user must be able to point at a thing on the screen and talk about it there, instead of taking a screenshot, switching to a generic chat, and describing the entire scene.

Support context at these levels: an epic/card; a selected set of cards; a whole Stretch Plan; an individual plan task; a worker and its Objective; a Needs You item; and an identifiable element or selected text within those surfaces. The interaction can use a context action, highlight, marker, or selection followed by a small composer. Exact gestures are a design choice; recreating the infinite canvas is not required.

### Anchor and message contract

A thread has a stable identity, ordered messages, author/recipient attribution, and anchors. An anchor should resolve to semantic object IDs and, where useful, field/text selections. For multi-selection, retain the exact set the user selected. Include enough relevant context and revision/snapshot information to understand what was visible when the message was sent.

Coordinates alone are not durable identity. If a card moves, the thread follows the card. If text changes or a target is archived, preserve the earlier reference/context and explain that it changed; do not silently attach the conversation to a different element occupying the same pixels.

Avoid automatically dumping every repository or the entire portfolio into the message. Start with the selected objects, their relevant context, and retrievable links. Treat quoted content, task documents, terminal excerpts, and external text as data, not as extra authorization instructions.

### First Mate is the V1 conversation partner

Every Context Thread routes to First Mate, even when anchored to a worker. First Mate can answer, inspect, delegate, or steer through its normal mechanisms. The UI must not quietly message the worker directly or substitute a separate side-question model.

Replies return to the originating thread. A durable note without a correlated reply path is not a completed Context Thread integration. Support repeated turns, not just “send a note and read the answer elsewhere.” An implementation can correlate one primary-inbox request per user message; it must account for the existing inbox's reply semantics rather than assuming one inbox note is an unlimited conversation. [S4]

Threads should be compact/collapsible, with an indicator on their anchor and an expandable history. They must not recreate the Slate's screen pollution by leaving every rich conversation expanded. Compose and read the thread in context, while preserving the selected work view.

Thread messages are conversation. Explicit decisions, approvals, and retries remain typed actions with recorded authority; do not guess that any favorable-sounding comment authorized a destructive operation.

---
## 11. Visual language and quota visibility

Keep Tin Star's **cyberpunk-cowboy** character. Simplifying its structure must not turn it into a generic gray enterprise dashboard. Reuse or reinterpret the existing palette, typography, robot/face identity system, and useful motion. Calm, scannable epic cards can coexist with a distinctive overall shell.

Quota meters remain persistently available in a compact area of the rail, naturally near its bottom. Preserve the usefulness of the existing visual meters rather than replacing them with a buried settings page or a wall of numeric diagnostics.

Preserve the provider sources already supported in the installation, including Claude, Codex, and Grok where supported. Unsupported providers must be identified, not filled with simulated quota data. Show provider/account identity, remaining capacity in the provider's actual units, reset information where known, and freshness/unavailability. Surface model-specific limits when they materially change what is available. Do not claim a precise “tokens left” value if the source only reports a usage-window percentage. Distinguish provider quota from a worker's context-window fullness.

Reuse existing Tin Star quota visuals and evaluate `quota-axi` as the shared provider-data source. First Mate retains dispatch/model selection. Tin Star does not introduce another quota optimizer or silently downgrade model capability.

A failed collector must show unavailable/stale data, not an empty bar interpreted as zero or a full bar interpreted as unlimited. Identity, status, attention type, and risk need visually distinct channels even when all use accents.

---

## 12. First Mate integration and terminal adapters

### Integrate with the real installation

Inspect the effective First Mate home, current code version, configured runtime backend, supported commands, and existing authority policies. Do not assume the public repository's default checkout is the running installation or that the planning agent can write upstream repositories.

Prefer documented reads and control interfaces. Keep any necessary First Mate extension narrow, observable, and compatible with existing callers. If new capabilities are missing, add a supported export/command rather than teaching Tin Star to manipulate internal files or tmux names.

### Read model and freshness

The existing fleet ledger is a useful documented event source. It is not a complete current-state database: the inspected contract omits relaunch events and live busy/idle state, can contain duplicates, and does not backfill workers dispatched before publication was enabled. It has no sequence/gap-detection guarantee. [S3]

Use a current inventory/snapshot or another supported reconciliation mechanism alongside events where necessary. Late attachment, reconnects, restarts, and missed publication must not produce phantom workers or falsely declare missing workers dead. Separate recorded task status from observed runtime activity, with source/freshness where necessary.

The current Tin Star observer already follows the fleet ledger and attaches live worker views, but its documentation explicitly identifies the private `.meta` join and conversation matching as interim/heuristic mechanisms. Do not promote those heuristics into authoritative V6 identity or lifecycle control. [S2]

### Agent-facing interface: AXI-quality, transport-independent

Use AXI's useful interface discipline: compact default lists, bounded detail with an explicit expansion path, meaningful summaries, explicit empty states, noninteractive operations, idempotence, actionable errors, and contextual discovery. Keep internal structured data separate from agent-facing formatting. AXI is an agent-CLI design discipline, not a substitute for a host integration transport. [S8]

A new command name such as `fm-axi` is illustrative, **not a required package or a claim that it already exists**. The planning agent should prefer the smallest extension of First Mate's actual command surface. Do not build parallel implementations for UI, CLI, and MCP.

Needed semantic operations include reading portfolio/plan/worker/attention state, submitting intentional edits, launching through First Mate, sending correlated thread messages and receiving replies, answering Needs You items, retrieving worker view descriptors, checking intake readiness/receipts, and requesting Tin Star focus changes. Exact tool names and grouping are engineering decisions.

Use bounded typed operations, not a generic arbitrary-shell endpoint. First Mate's scripts can retain their own verified implementation; Tin Star's browser must not be allowed to pass unchecked shell commands or arbitrary tmux targets.

### Native desktop assistant boundary — verify before promising

The preferred experience keeps the general First Mate conversation in a separate native desktop assistant, with Claude Desktop as an example. Local MCP/desktop extensions are a documented integration path for that client. [S10]

**Tool access is not proof of autonomous supervision.** First Mate is an agent distribution whose supported harnesses provide specific startup, tools, wake, supervision, and persistence behavior. A native chat with local tools is not automatically equivalent to a supported First Mate primary harness. [S9]

The planning agent must verify how commands, wake handling, attention delivery, reply correlation, and continued supervision work in the actual chosen client. Keep the working First Mate runtime intact during this work. A native assistant can be an interface to that runtime where supported; do not silently replace the runtime, launch a competing chief of staff, or automate native window typing as the integration.

Use a thin local MCP adapter when required by the client, backed by the same authority/intake services as other callers. Do not assume MCP can inject arbitrary asynchronous messages into an existing native conversation or keep it executing unattended without testing that behavior. Any limitation must be reported accurately, and must not block the basic Tin Star dashboard from working with the existing First Mate session.

### Runtime/view descriptor

First Mate owns the backend and the actual worker endpoint. Tin Star receives a documented descriptor with the information/capabilities needed by a view adapter. Generic worker records must not encode an assumption that every worker is a Tin Star-owned tmux session. A tmux adapter may, naturally, know about tmux.

If an adequate descriptor is not currently published, the integration work should add a small First Mate-owned read/export interface. First Mate can interpret its own metadata; Tin Star should not discover workers by reconstructing private naming conventions. Bind endpoint reuse and reconnection to the right worker/incarnation.

### Local tmux and ttyd first

For the initial implementation, support First Mate's existing local tmux workers. Tin Star may create and dispose of **view infrastructure**, such as ttyd processes and dedicated attachment sessions. It does not thereby own the worker or its worktree.

The existing observer's `tsview-*` technique links the real worker window into a dedicated view session and serves it through ttyd. Its documented intent is that closing the view cannot kill the worker. This is a useful starting point, not a requirement to preserve all existing code. [S2]

Required properties:

- Opening a view attaches to the intended existing worker; it does not launch a replacement worker or alter First Mate's session organization.
- Closing, hiding, navigating away from, or crashing a view does not stop the worker or clean up its worktree.
- Multiple views do not accidentally switch each other's selected workers or First Mate's main window.
- First Mate can continue to inspect, steer, control, and clean up its workers while views are attached.
- View cleanup is restricted to view-owned resources. It cannot match First Mate's resources through ambiguous name prefixes.
- Keyboard handling and scrollback/copy-mode behavior do not break First Mate's message delivery. Session-switch hotkeys remain usable.
- A missing or replaced endpoint becomes an honest unavailable/reconnect state, not attachment to another worker that happens to reuse its name or port.
- Terminal switching does not repeatedly resize/reflow live terminals solely because view selection changed.

The worker terminal is the actual terminal affordance, not a fabricated transcript. If raw typing is exposed, it is direct terminal I/O and must be clearly distinct from a Context Thread or a structured Tin Star command. Context Threads still go to First Mate. Structured stop/relaunch/steer actions still use First Mate's supported interfaces; do not implement them as simulated terminal text.

The adapter must account for possible interleaving between human terminal input and supervisor delivery. Do not claim that a linked view magically serializes those inputs. Test the actual runtime interaction and preserve First Mate's well-tuned behavior.

### Local security boundary

Keep worker terminal services local and access-controlled through the intended local application boundary. Do not expose a terminal or command endpoint to the public internet to make a native connector convenient. Validate object identities, requested operations, paths, and external link schemes; avoid shell interpolation and executable agent-authored UI.

A local single-user application still needs protection from accidental wrong-target commands and unrelated web origins. Reuse suitable existing protections and document the boundary without inventing a large security platform.

---

## 13. Engineering defaults and choices left open

These are **recommendations or implementation decisions**, not reasons to reopen settled product design.

| Area | Guidance |
|---|---|
| Frontend/backend stack | React/TypeScript and a small local service are sensible reuse candidates. Retain or replace the current build/server packaging based on actual cost, not version-number enthusiasm. |
| Kanban mechanics | Evaluate Atlassian Pragmatic Drag and Drop first if useful; compare alternatives. It is explicitly a suggestion, not a requirement. |
| Durable storage | Files or SQLite in a First Mate-owned local area. Keep authoritative ownership and safe concurrent updates; avoid a separate cloud backend. |
| UI updates | Reuse a simple snapshot plus event/SSE/WebSocket mechanism as appropriate. Do not mistake a lossy activity log for a complete event-sourced database. |
| Stretch Plan presentation | Embed or integrate the existing planner where practical, with command interception/adapter support for the agreed write boundary. Avoid unnecessary renderer replacement. |
| First Mate interface | Extend existing primary-inbox, reads, and lifecycle commands narrowly. AXI-quality ergonomics; MCP only where the host needs it. |
| Terminal | Local tmux + ttyd attachment first; opaque/generic worker identity with a backend-specific view adapter. |
| Card layout | Jira/Notion-like scanability within the Tin Star visual system. Exact epic-card fields and proportions can change. Needs You subtype structure cannot vary arbitrarily. |
| Expanded attention | Modal, drawer, or anchored panel according to usability. Not a universal mandatory layer. |
| Motion | Fast, interruptible contextual transitions. Do not animate through unused intermediate views. |
| Identity after replacement | Preserve logical identity where appropriate and make generations traceable; fit First Mate's actual identity model. |
| Schedule threshold | Choose and document a sensible material-overrun default; preserve continue-and-escalate behavior. |
| Initiative layout | Grouping, filtering, swimlanes, and summary headers are options. Support standalone epics in every case. |

### Explicitly superseded ideas

Superseded design ideas: an infinite zoomable canvas; a mandatory portfolio-to-terminal ladder; a permanent selected-worker terminal beside the board; compulsory initiatives/epics for quick work; hard-coded Kanban columns; a separate Review queue; a fundamental rewrite of Stretch Plan's planning semantics; a second Tin Star worker scheduler; or preservation of all V5 infrastructure.

Also do not infer that every worker must receive a cheaper model, that every plan may automatically start without authorization, or that the user must specify every card's pixel layout. Those are not requirements.

---

## 14. Implementation course of action

### Planning deliverables

Before broad implementation, First Mate's planning worker should produce:

1. A repository-grounded architecture/design specification that maps this contract to the actual systems and identifies existing versus missing integration capabilities.
2. An implementation specification with bounded units, file/module ownership, validation, and a clear definition of completion.
3. A Stretch Plan with project-local executable tasks, dependencies, design links, **wall-clock-hour** budgets, expected concurrency, and a visible overall schedule.
4. A short list of real blockers or authority decisions, each with evidence and a proposed resolution. Do not use this to return styling trivia to the user.

Use the selected Compound Engineering artifact conventions. Do not mark a plan implementation-ready while the primary delivery path, runtime attachment, or other launch-critical dependencies remain unproven. Scope a bounded technical investigation when necessary instead of quietly guessing.

### Recommended sequence

| Stage | Work and exit condition |
|---|---|
| A — Prove the boundary | Identify the effective First Mate installation. Demonstrate current worker discovery, safe attachment to a real worker, one durable inbound command, and a correlated result. Verify native-client assumptions separately. |
| B — Establish associations | Add the smallest First Mate-owned portfolio/column/linkage/objective/thread/attention storage and command support needed. Connect to existing Stretch Plan and worker records without copying their lifecycle logic. |
| C — Build the shell | Implement the two-pane UI, worker identity/header, quota area, direct navigation, real worker views, terminal attachment, and bracket-key cycling. |
| D — Add portfolio and planning | Configurable columns, standalone epics, epic cards, integrated Stretch Plan/task views, and a lightweight First Mate launch path with correct associations. |
| E — Close interaction loops | All six Needs You renderers, compact actions, decision expansion, PR links, Context Threads with in-place replies, and durable pending/error states. |
| F — Add accountability and harden | Schedule drift that continues execution and escalates, completed-epic aging, reconnection/replay tests, runtime noninterference tests, and final usability review. |

The planner can reorder independent work. Every task still needs one repository owner, a concrete output, dependencies, validation, and a wall-clock budget. Changes needed in First Mate belong in First Mate's supported code/extension surface, not in an undocumented Tin Star patch to its private state.

The likely repositories are `except-pass/tinstar`, `except-pass/stretchplan`, and a writable checkout/fork of `kunchenguid/firstmate`. Treat `kunchenguid/axi` and Compound Engineering as references/dependencies unless a demonstrated change is needed. Verify repository access and the correct branch before making changes. Do not assume authority to push to an upstream maintainer's repository.

### First demonstrable slice

Prioritize a real path: see an existing First Mate worker with its identity, objective, project, and worktree; open its actual terminal; cycle to another worker; jump directly to the board; submit an anchored message or explicit action through the primary inbox; observe a correlated result without disrupting execution.

A UI fixture can accelerate development, but label it clearly. A mock board/worker/receipt demonstration is not proof of integration. The slice is a checkpoint, not permission to omit Needs You types, Context Threads, or schedule accountability from the completed V1.

### Delivery handoff

Deliver startup instructions, required local configuration, how to connect the First Mate home, how to reach the board and workers, the keyboard shortcuts, the native-client integration status, test evidence, and known limitations. Provide a concrete record of files/branches/PRs changed and what remains unfinished.

Report progress against the schedule using completed outputs and evidence, not the number of tool calls or assurances that an agent is busy. Preserve work and escalate if a task expands beyond its budget. Do not churn indefinitely on a generalized framework when a smaller implementation meets this contract.

---

## 15. Acceptance and regression contract

Tests should demonstrate product behavior with real integration where it matters. Use isolated First Mate/test homes and private tmux servers for destructive lifecycle tests, not the production worker fleet. The exact test framework is an engineering choice.

| Test | Pass condition |
|---|---|
| T01 — Standalone launch | Project + objective can create a First Mate-managed worker without initiative, epic, or plan setup. Retries of the same request do not create duplicates. |
| T02 — Attached launch | Launching from a task uses the correct project and persists task/plan/epic/initiative relationships that exist, without inventing missing ancestors. |
| T03 — Cross-project organization | An initiative coordinates several epics/projects; each implementation task has one project; actual cross-project dependencies are represented without treating all related streams as blockers. |
| T04 — Configurable workflow | Custom column names/descriptions work, including renamed completion columns. No hard-coded label drives hidden execution semantics. |
| T05 — Intent and receipt | A card drag reaches First Mate durably. Pending is visible; an applied result reconciles; a failure or stale edit is explained. No direct authoritative UI write occurs. |
| T06 — Primary unavailable | Actions remain durably queued or fail explicitly. The UI does not claim delivery/processing merely because an inbox file was saved or a pane exists. |
| T07 — Direct navigation | Terminal → Portfolio and rail → selected worker/attention target take one intentional jump, with no intermediate-view traversal. Back restores actual prior context. |
| T08 — Rapid cycling | Repeated bracket shortcuts work from a worker, composer, and live terminal. Order is stable, identity updates immediately, and no worker is restarted or input draft lost. |
| T09 — Visual identity | The same worker's name/face/color and project/worktree context agree across rail, task, worker, terminal, and attention provenance. Refresh does not randomly reassign them. |
| T10 — Objective | A standalone and an attached worker each have one current Objective. It is visible/addressable, revisions are durable, and a narrower objective cannot silently complete a broader task. |
| T11 — Six fixed attention types | Fixtures for all six types use consistent layouts within the type and are distinguishable across types without relying only on color. Every compact card has a useful action. |
| T12 — Rich decision | Options, concrete tradeoffs, wrong-if conditions, all risk dimensions, reversal, horizon, and comment remain available. Quick choice and full expansion both work; stale choices cannot authorize a changed decision. |
| T13 — PR review | Compact card shows headline, repo, PR number, and direct GitHub link. Opening it is not treated as approval, merge, or resolution; no mandatory modal intervenes. |
| T14 — Drift | A task exceeding the configured material wall-clock threshold raises/updates one drift item. The worker continues. Retry/relaunch and refresh do not erase elapsed time or the agreed baseline. |
| T15 — Attention durability | An open item survives originating-worker termination. An answer survives UI/First Mate restart and can be applied once; unanswered, queued, and resolved are not conflated. |
| T16 — Context anchors | Threads can target a card, multiple cards, a plan, and a plan task. The target identities and relevant context arrive at First Mate without the user describing the screen. |
| T17 — Thread conversation | First Mate replies to the same local thread across multiple turns. Moving/archiving the anchor or changing views does not lose the conversation; all V1 thread routing remains through First Mate. |
| T18 — Existing workers | Opening V6 discovers or honestly reconciles workers already launched before it started, rather than requiring Tin Star to launch them again. |
| T19 — Runtime attachment safety | Open/close/reload/multiple views leave First Mate's worker lifecycle and worktrees untouched. First Mate steering/control still works, and view cleanup cannot kill a worker. |
| T20 — Stale endpoint safety | Worker replacement or endpoint reuse never attaches an old card to an unrelated new worker. The UI shows unavailable/reconnect/changed-state information as appropriate. |
| T21 — Event honesty | Duplicate/out-of-order ledger records, missing history, and failed observations do not produce duplicate workers, false completion, or a false healthy status. |
| T22 — Quotas | Real source values and reset/freshness information display correctly. Missing data is explicit. Worker context fullness is not mislabeled as account quota. |
| T23 — Completion aging | Completed epics remain visible for roughly seven days, then archive out of the active board with links/history retained. Viewing them does not postpone aging; reopening restores active visibility. |
| T24 — Motion and accessibility | Direct jumps and rapid switches do not wait on animation. Reduced motion works; focus/keyboard navigation survives modal close, view change, and terminal interaction. |
| T25 — Native-client claim | Any advertised native First Mate integration is demonstrated for commands, correlated results, and supervision/wake behavior. Unsupported pieces are identified rather than assumed from MCP availability. |
| T26 — Rewrite safety | The new build and tests do not discard existing First Mate records, change its configured dispatch/merge policy, or tear down unrelated V5/First Mate sessions. |

### Definition of done

The final V1 must deliver the intended end-to-end workflow on the local First Mate setup: lightweight launch or planned work; coherent organization; recognizable workers and safe terminal views; direct keyboard/link navigation; actionable typed attention; anchored conversations with replies; schedule accountability; and trustworthy state after reconnect/restart.

Any unimplemented acceptance item is reported explicitly. A visually convincing mock, a ledger-only observer without commands, or a fire-and-forget inbox without reply handling is not the completed product.

---

## 16. Repository grounding and implementation cautions

These references ground the integration discussion. They do not override the product decisions above. The planning agent must inspect the actual target checkout and pin the versions it builds against. This handoff is based on targeted inspection, not a comprehensive audit of every file.

### Confirmed boundaries worth carrying forward

**Primary intake exists.** `fm-inbox.sh` distinguishes capture, side questions, receipts, and readiness. Its request-ID path is idempotent; saved-but-unannounced is distinct from nothing-saved; a reply is correlated to a note. This is a better starting point than inventing another inbox. Its current one-reply-per-note contract needs deliberate thread-message mapping. [S4]

**The ledger is not the whole runtime.** Its documented limits require reconciliation and honest unknown states. In particular, a `task.dispatched` event is not emitted for every relaunch, and task-status text is not a live busy/idle feed. [S3]

**The terminal view already has useful safety work.** The existing Tin Star observer separates observed workers from owned sessions and uses dedicated linked views. Its private-metadata and heuristic-transcript dependencies are explicitly documented as such. Reuse the safety lessons while improving the integration boundary. [S2]

**Stretch Plan already integrates Compound Engineering.** The planning skill creates a board of linked implementation plans; the execution skill currently assumes Tin Star-owned hands. The integration work is primarily changing execution ownership and adding the agreed schedule/portfolio behavior, not discarding the planner's useful semantics. [S5–S7]

**The rich decision model is real.** V5's control model includes gain/cost/wrong-if, the three risk dimensions, separate action/damage reversal, and horizon. It explicitly avoids a composite score and avoids coercing unknown risk into a known rating. [S1]

### Source index

Source URLs are references for implementation. First Mate and Tin Star references are pinned where a commit was verified; other sources must be pinned during implementation planning.

| Ref | Source and what to inspect |
|---|---|
| S1 | Tin Star decision contracts, pinned commit `7b782d58a5e6282f1c759f9df92c02d3232b55d6`: `src/a2ui/controls.ts`; related renderer/catalog: `src/a2ui/controlComponents.tsx`, `src/slate/surfaceCatalog.ts`. URL: `https://github.com/except-pass/tinstar/blob/7b782d58a5e6282f1c759f9df92c02d3232b55d6/src/a2ui/controls.ts` |
| S2 | Tin Star First Mate observer contract at the same commit: `docs/features/firstmate-observer.md`; related code: `src/server/firstmate/`, `bin/tinstar-fm-view`, `src/plugins/firstmate/`. URL: `https://github.com/except-pass/tinstar/blob/7b782d58a5e6282f1c759f9df92c02d3232b55d6/docs/features/firstmate-observer.md` |
| S3 | First Mate ledger contract, pinned commit `b42d4fa8a752fad9a5f0235783b02534bce29219`: `docs/fleet-ledger.md`. URL: `https://github.com/kunchenguid/firstmate/blob/b42d4fa8a752fad9a5f0235783b02534bce29219/docs/fleet-ledger.md` |
| S4 | First Mate primary inbox, same commit: `bin/fm-inbox.sh`, especially the interface/guarantees in its header. URL: `https://github.com/kunchenguid/firstmate/blob/b42d4fa8a752fad9a5f0235783b02534bce29219/bin/fm-inbox.sh` |
| S5 | Stretch Plan README: plan file, task slots, `unit`, revisions, links, subplans, and UI/CLI behavior. URL: `https://github.com/except-pass/stretchplan/blob/main/README.md` |
| S6 | Stretch Plan planning skill: `skills/plan-the-work/SKILL.md`; verified content blob `43ce3b9a628510b5060a071adebfdcd7c16ed530`. Also inspect its board-mechanics and charter references. URL: `https://github.com/except-pass/stretchplan/blob/main/skills/plan-the-work/SKILL.md` |
| S7 | Stretch Plan execution skill: `skills/work-the-plan/SKILL.md`, including its existing Tin Star dispatch path and evidence reconciliation. URL: `https://github.com/except-pass/stretchplan/blob/main/skills/work-the-plan/SKILL.md` |
| S8 | AXI principles/specification, inspected at commit `6b63d8fc40568459d4ea029c4623db389d501f0b`: `.agents/skills/axi/SKILL.md`, `principles.yaml`. URL: `https://github.com/kunchenguid/axi/blob/6b63d8fc40568459d4ea029c4623db389d501f0b/.agents/skills/axi/SKILL.md` |
| S9 | First Mate identity/runtime/supervision contract: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/agent-control.md`, and selected backend documentation. Inspect current versions of `bin/fm-spawn.sh`, `bin/fm-send.sh`, and `bin/fm-control.sh` before using them. Starting URL: `https://github.com/kunchenguid/firstmate/blob/b42d4fa8a752fad9a5f0235783b02534bce29219/README.md` |
| S10 | Anthropic, “Getting Started with Local MCP Servers on Claude Desktop,” checked September 24, 2026. Establishes local extension/tool integration, not First Mate-specific autonomous supervision. URL: `https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop` |

Additional reuse candidates from the Tin Star checkout: `src/components/CanvasHud/ProviderQuotaCards.tsx`, `CcQuotaCard.tsx`, `CcQuotaClock.tsx`; `src/focusMode/`; the Focus Mode and hotkey documentation; existing avatar/identity utilities; and the Objective/Slate implementation. Inspect before porting. Refer to EveryInc's installed Compound Engineering skills and their actual version rather than assuming a particular historical artifact layout.

---
