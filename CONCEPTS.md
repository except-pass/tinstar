# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Agents & sessions

### Managed session
An agent session that Tinstar spawns, tracks, and renders on the dashboard — backed by a terminal multiplexer, with its own workspace directory, a stable session name, and a lifecycle the control plane observes and steers. "Managed" distinguishes it from an arbitrary shell: the backend injects a known set of identity and connectivity values into its environment and watches its status.

A managed session can only rely on the environment values the backend explicitly injects (its own session name, the dashboard URL, secrets, telemetry vars) — not on the server's own startup configuration. Its NATS channel connectivity is provisioned per-session as config the backend generates, not as injected environment variables.

### Hand
A managed session spawned as the child of another, inheriting the parent's worktree, task assignment, and NATS subscriptions. A hand is a persistent, conversational collaborator that talks back to its spawner over NATS rather than the prompt API.
*Avoid:* subagent (a subagent is a lighter, one-shot helper that is not a managed session).

### Background session
A managed session flagged at creation (or by later demotion) to stay off the canvas, hierarchy, and inbox while remaining fully alive and commandable over NATS and the prompt endpoint. Machinery, not a collaborator: it idles, acts on commands, and typically ends its own session. A needs-attention state (permission prompt, error) breaks through to the inbox despite the flag; a reveal toggle in the hierarchy shows background sessions on demand.
*Avoid:* hidden run (a distinct concept — see Hidden run).

### Hidden run
A run a user has toggled off the canvas via the per-run eyeball — a per-browser view preference on a normal, fully-alive session, not a change to the session itself. The run stays in the hierarchy (dimmed) so it can be re-shown, and is skipped by canvas cycling. Distinct from a Background session: hidden is a client-side, per-browser view choice; background is a server-side flag on the session's nature.

A hidden run's state is keyed to the run's identity and is dropped when the run is removed, so re-creating a run under a reused name does not inherit a prior hide.

### Agent skill
A documented capability — a `SKILL.md` with name/description frontmatter — installed into a harness's skills directory to teach an agent how to perform a Tinstar workflow. Skills are instructions only (no slash commands), and are symlinked or copied into any harness directory that has a skills folder.

## Backend & events

### Standalone backend
The single-process server that serves the HTTP API, the server-sent-event stream, static assets, and session management together as one deployment. Distinct from the Vite dev server used during frontend development; the two can run on different ports, and a newly added API route is not live on a running standalone until its bundle is rebuilt and the process restarted.

### SSE bridge
The mechanism that re-dispatches named server-sent events from a single shared event stream onto the frontend as window events, so React consumers subscribe by name without each opening its own connection. A new pushed event type becomes available to the UI by being added to the bridge's forwarded-events set and given a typed window-event name.

## Surfaces

### The Slate
A region of a run's workspace card where an agent, the user, or any local process paints small interactive surfaces scoped to that one run — an open-points list, diagram panels, forms, or live progress cards. Surfaces are described in A2UI and drawn by the shared host renderer. Authoring is file-in (a process writes a surface file into the run's worktree; a server watcher validates and projects it onto the run), while threads, lifecycle status, and control answers are answered HTTP-out and owned by the store. Distinct from the Roundup, which is a cross-session board; the Slate is per-run.

### Addressable point
The single primitive the Slate is built from: a durable, threaded item authored by an agent, a user, or a process, optionally anchored to a decision or a whole surface, carrying an append-only discussion thread and a soft lifecycle (open, discussing, waiting, resolved, dismissed). A Roundup notice, a canvas pin, and a per-surface discussion are the same object with a different anchor and default author. One id is reserved: a point at `objective` is the run's Objective and may only be written by the user, so a file-authored or HTTP-created point may not claim it.

### The Objective
A run's standing statement of what the session is for: one short piece of user-written prose, pinned above every other surface on that run's Slate and editable in place. It is a reserved user-owned point rather than a new entity, which is why a run has exactly one and why neither an agent's surface file nor an add-a-point request can overwrite or retract it. Distinct from the run's launch prompt, which is delivered once at spawn, cannot be edited afterwards, and leaves no artifact — the Objective is durable, visible, and re-deliverable. Applying an edit both persists it and nudges the run's agent to re-align; typing alone never does, so the agent is only ever interrupted by a deliberate press.

### Surface
A single interactive panel on the Slate — the unit an agent, user, or process authors and the user touches independently. Each surface is an addressable point rendered as its own card: an open point in the grouped list, a standalone diagram, a form, or a progress panel. A surface's body is written in A2UI; its identity, discussion thread, and lifecycle status are owned by the store, so re-authoring a surface under the same identity amends it without discarding what has accumulated on it.

### A2UI
The bounded, host-rendered UI description language a surface's body is written in: a flat set of components — text, layout rows and columns, lists, cards, links, and interactive controls — referenced by id from one root. Closed vocabulary, open composition: an agent composes from a fixed catalog the host draws in its own theme, rather than shipping arbitrary markup or styles. A body that is not valid A2UI is rejected at the boundary and never renders.
