# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Agents & sessions

### Managed session
An agent session that Tinstar spawns, tracks, and renders on the dashboard — backed by a terminal multiplexer, with its own workspace directory, a stable session name, and a lifecycle the control plane observes and steers. "Managed" distinguishes it from an arbitrary shell: the backend injects a known set of identity and connectivity values into its environment and watches its status.

A managed session can only rely on the environment values the backend explicitly injects (its own session name, the dashboard URL, NATS connection vars, secrets, telemetry vars) — not on the server's own startup configuration.

### Hand
A managed session spawned as the child of another, inheriting the parent's worktree, task assignment, and NATS subscriptions. A hand is a persistent, conversational collaborator that talks back to its spawner over NATS rather than the prompt API.
*Avoid:* subagent (a subagent is a lighter, one-shot helper that is not a managed session).

### Agent skill
A documented capability — a `SKILL.md` with name/description frontmatter — installed into a harness's skills directory to teach an agent how to perform a Tinstar workflow. Skills are instructions only (no slash commands), and are symlinked or copied into any harness directory that has a skills folder.

## Backend & events

### Standalone backend
The single-process server that serves the HTTP API, the server-sent-event stream, static assets, and session management together as one deployment. Distinct from the Vite dev server used during frontend development; the two can run on different ports, and a newly added API route is not live on a running standalone until its bundle is rebuilt and the process restarted.

### SSE bridge
The mechanism that re-dispatches named server-sent events from a single shared event stream onto the frontend as window events, so React consumers subscribe by name without each opening its own connection. A new pushed event type becomes available to the UI by being added to the bridge's forwarded-events set and given a typed window-event name.
