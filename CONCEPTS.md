# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Agents & sessions

### Managed session
An agent session that Tinstar spawns, tracks, and renders on the dashboard — backed by a terminal multiplexer, with its own workspace directory, a stable session name, and a lifecycle the control plane observes and steers. "Managed" distinguishes it from an arbitrary shell: the backend injects a known set of identity and connectivity values into its environment and watches its status.

A managed session can only rely on the environment values the backend explicitly injects (its own session name, the dashboard URL, secrets, telemetry vars) — not on the server's own startup configuration. Its NATS channel connectivity is provisioned per-session as config the backend generates, not as injected environment variables.

### Hand
A managed session spawned as the child of another, inheriting the parent's Project/Worktree scope and NATS subscriptions. A hand is a persistent, conversational collaborator that talks back to its spawner over NATS rather than the prompt API.
*Avoid:* subagent (a subagent is a lighter, one-shot helper that is not a managed session).

### Background session
A managed session flagged at creation (or by later demotion) to stay off the canvas, hierarchy, and inbox while remaining fully alive and commandable over NATS and the prompt endpoint. Machinery, not a collaborator: it idles, acts on commands, and typically ends its own session. A needs-attention state (permission prompt, error) breaks through to the inbox despite the flag; a reveal toggle in the hierarchy shows background sessions on demand.
*Avoid:* hidden run (a distinct concept — see Hidden run).

### Hidden run
A run a user has toggled off the canvas via the per-run eyeball — a per-browser view preference on a normal, fully-alive session, not a change to the session itself. The run stays in the hierarchy (dimmed) so it can be re-shown, and is skipped by canvas cycling. Distinct from a Background session: hidden is a client-side, per-browser view choice; background is a server-side flag on the session's nature.

A hidden run's state is keyed to the run's identity and is dropped when the run is removed, so re-creating a run under a reused name does not inherit a prior hide.

### Organizational scope
The host-owned Project and optional Worktree membership used to organize any canvas widget. A Worktree belongs to one Project, so Worktree scope always implies its Project ancestry; a widget with neither is Unscoped. Scope determines the live hierarchy and the result of the explicit Organize action, but never filters widget contents or moves a widget merely because its scope changed.

### Organize
The one-shot whole-canvas action that projects current organizational scope into visible Project and Worktree containers while arranging Unscoped widgets as standalone peers. It carries forward Reset Layout's packing behavior and preserves snapped constellations. Hierarchy changes accumulate without moving canvas widgets until the user invokes Organize.

### Agent skill
A documented capability — a `SKILL.md` with name/description frontmatter — installed into a harness's skills directory to teach an agent how to perform a Tinstar workflow. Skills are instructions only (no slash commands), and are symlinked or copied into any harness directory that has a skills folder.

## Backend & events

### Standalone backend
The single-process server that serves the HTTP API, the server-sent-event stream, static assets, and session management together as one deployment. Distinct from the Vite dev server used during frontend development; the two can run on different ports, and a newly added API route is not live on a running standalone until its bundle is rebuilt and the process restarted.

### SSE bridge
The mechanism that re-dispatches named server-sent events from a single shared event stream onto the frontend as window events, so React consumers subscribe by name without each opening its own connection. A new pushed event type becomes available to the UI by being added to the bridge's forwarded-events set and given a typed window-event name.

## Surfaces

### Focus mode
A per-browser view of one Run Workspace that temporarily fits the existing workspace to the available canvas viewport at normal visual scale. Focus mode suppresses canvas arrangement and non-run widget interactions without changing the saved canvas layout, so returning to the canvas restores the prior arrangement. Distinct from the `Z` canvas utility and from the separate phone-oriented mobile projection.

While Focus mode is active, mounted built-in Run Workspaces share the same transient viewport geometry and responsive presentation. Cycling changes which prepared workspace is visible rather than resizing terminals; genuine viewport changes may resize them, and leaving Focus restores each saved Canvas layout.

### The Slate
A region of a run's workspace card where an agent, the user, or any local process paints small interactive surfaces scoped to that one run — an open-points list, diagram panels, forms, or live progress cards. Surfaces are described in A2UI and drawn by the shared host renderer. Authoring is file-in (a process writes a surface file into the run's worktree; a server watcher validates and projects it onto the run), while threads, lifecycle status, and control answers are answered HTTP-out and owned by the store. Distinct from the Roundup, which is a cross-session board; the Slate is per-run.

Slate content is **semi-ephemeral**: surfaces are cheap to wipe and re-author, so a change to the authoring contract is resolved by clearing the Slate rather than by migrating it. This is why breaking changes to surface shape are acceptable and why durable value belongs in host-owned machinery rather than in any individual card.

### Addressable point
The single primitive the Slate is built from: a durable, threaded item authored by an agent, a user, or a process, optionally anchored to a decision or a whole surface, carrying an append-only discussion thread and a soft lifecycle (open, discussing, waiting, resolved, dismissed). A Roundup notice, a canvas pin, and a per-surface discussion are the same object with a different anchor and default author. One id is reserved: a point at `objective` is the run's Objective and may only be written by the user, so a file-authored or HTTP-created point may not claim it.

### The Objective
A run's standing statement of what the session is for: one short piece of user-written prose, pinned above every other surface on that run's Slate and editable in place. It is a reserved user-owned point rather than a new entity, which is why a run has exactly one and why neither an agent's surface file nor an add-a-point request can overwrite or retract it. Distinct from the run's launch prompt, which is delivered once at spawn, cannot be edited afterwards, and leaves no artifact — the Objective is durable, visible, and re-deliverable. Applying an edit both persists it and nudges the run's agent to re-align; typing alone never does, so the agent is only ever interrupted by a deliberate press.

### Surface
A single interactive panel on the Slate — the unit an agent, user, or process authors and the user touches independently. Each surface is an addressable point rendered as its own card: an open point in the grouped list, a standalone diagram, a form, or a progress panel. A surface's body is written in A2UI; its identity, discussion thread, and lifecycle status are owned by the store, so re-authoring a surface under the same identity amends it without discarding what has accumulated on it.

A Surface is also the atomic refresh boundary. A refreshable Surface has one recipe, one whole-Surface result, and one freshness record; independently refreshed content belongs on separate Surfaces composed by the Slate. Its last-known result remains real information even when dirty, provided the Surface shows when that result was known and when freshness was last checked.

### Optimistic surface shell
The visible card Tinstar creates as soon as it accepts an Add surface request, before asynchronous authoring has produced the body. It reserves the final Surface's identity and position, shows authoring progress, and becomes ready or failed in place. The shell is the creation receipt; dispatching an author without creating one is not visible success.

Each attempt writes only to the host-assigned file and local ID and carries a host-issued attempt token. The watcher fills the reserved card only when that token is still current, so a late first attempt cannot overwrite a successful retry. The token correlates work; it is not a credential.

### Refresh recipe
The single instruction that rebuilds one whole Surface, and the thing that decides who is allowed to run it. A **host** recipe names a machine check from a closed, code-owned list: it is read-only, bounded, cannot invoke a model or create a session, and the host may therefore run it on its own. An **agent** recipe is prose, delivered to the Surface's existing foreground collaborator, and runs only when a person deliberately reaches the Surface. Prose can never become a host recipe however it is worded — machine authority comes from naming a registered handler, which an author has no way to forge. A recipe the host cannot read is kept and reported rather than dropped, so a mistyped one says so instead of leaving a Surface that quietly never updates.

### Dirty vs refreshing
Two different things a Surface can be, deliberately kept apart. **Dirty** means an observation has invalidated it: a commit landed, a deadline passed, a claim moved. Marking is cheap and happens freely. **Refreshing** means an executor is actually rebuilding it right now, which for an agent recipe requires a person to have asked. Making the two synonymous is what produced a background agent per matching event; separating them is what makes an open dashboard cost nothing.

### Last known vs last checked
The two facts a Surface presents about its own freshness. **Last known** dates the content on screen and moves only when that content is replaced. **Last checked** dates the host's most recent completed look and records how it ended — succeeded, failed, unavailable (nothing could look), or superseded (the world moved first). A check that succeeds and finds nothing to change moves only the second, which is the common case: collapsing them into one timestamp reports month-old content as fresh.

### Lookup broker
The single gate every proactive host check passes through before it leaves the process. It holds a host-wide concurrency budget, a per-provider budget, and an in-flight map keyed by provider plus a stable question identity, so many Surfaces asking the same question share one answer and the second asker consumes no budget at all. Its purpose is that Surface count cannot buy provider load. A request it declines is **deferred**, which is not a failure and is recorded nowhere: nothing looked, so there is nothing to write down.

### Dismissed vs deleted
Two different endings, deliberately kept apart. **Dismissed** is a discussion outcome on an addressable point: the question was raised and the user decided it needs nothing further. The surface stays exactly where it is and remains visible. **Deleted** is structural: the surface and its descendants move into the recovery store, out of the workspace, and can be restored to their former home. A dismissed surface is still there and settled; a deleted one is gone but recoverable. Only **purge** erases, and only a deleted surface can be purged.

### Container surface
A surface that holds other surfaces. "Container" describes the surface's current structural role, not a separate entity or interaction model: it keeps the same title, content, prompt thread, presence, freshness, provenance, and minimize/hide/delete behavior as any other surface. A container may also carry its own authored summary or diagram. Each child surface has one home container, so recursive composition forms a tree rather than a multi-parent graph.

### Attention rail
A collapsible, scoped projection of surfaces that need the user, are actively changing, or changed recently. It helps the user search, filter, and jump to work without reordering the stable surface workspace; an explicit show-only action may temporarily filter the view.

### A2UI
The bounded, host-rendered UI description language a surface's body is written in: a flat set of components — text, layout rows and columns, lists, cards, links, and interactive controls — referenced by id from one root. Closed vocabulary, open composition: an agent composes from a fixed catalog the host draws in its own theme, rather than shipping arbitrary markup or styles. A body that is not valid A2UI is rejected at the boundary and never renders.

### Claim
A falsifiable statement a surface makes about the world, declared alongside its body: it names the kind of check that could refute it, what that check needs to run, and where the check is made. A claim never states what is currently true — only what would prove the surface wrong — which is why the declaration belongs to the surface's author while every value later observed for it belongs to the host. Editing a claim is an authoring change; observing one is not.

A surface may declare any number, including none. Declaring an empty list is itself a statement — the author looked and found nothing checkable — and is deliberately kept distinct from never having said. The authoring convention is that a newly authored surface declares at least one. Components in the body may reference a claim by id, which is how a card's own contents can be derived from what the host observed instead of from what its author believed on the day they wrote it.

### Witness
The host-owned check that can settle one claim, named by kind from a closed set the host implements. A claim naming a kind the host does not have, or supplying the wrong parameters for the kind it names, is refused and reported on the card rather than only logged — and refusing costs that one claim, never the whole surface.

Running a witness produces one of three outcomes, and the third is the load-bearing one: a value a completed lookup returned, "nobody could look", or "this claim is broken and someone must edit it". Only a value can agree with what was stored, so a witness that has been failing since it was written can never keep confirming its own card. A witness runs without waking an agent, which is what makes checking a surface cheap and rebuilding it rare.

### Locus
Where a claim's truth lives — the repository a run works in, or deployed infrastructure reached over the network. Distinct from what *announced* a change: an announcement says something happened, a locus says where the observation that could falsify a claim is made, and one locus is reachable from several kinds of announcement. Because a locus is declared, it narrows work in both directions: a commit reaches only the surfaces whose claims are about the repository, and a surface whose claims are all about infrastructure is left alone by it while still being checked on its own schedule.

### Unwitnessed
A surface that declares nothing which could prove it wrong. Distinct from stale, overdue, or unverified — those are all statements about a surface the host *could* check. Unwitnessed means there is nothing to check, and the card says so plainly instead of passing for current. It gates no controls and changes no scheduling: it is an honesty label, not a state anything acts on.

A surface that does declare a claim but has never had one checked is a third thing, and reads differently again — it shows no age at all, because the age a surface displays is the last moment every one of its claims held, not the last time its file was saved.
