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
