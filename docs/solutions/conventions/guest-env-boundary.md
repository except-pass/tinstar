---
title: "Tinstar's own env must not cross into guest sessions — the guest env boundary"
date: 2026-07-27
category: conventions
module: server-sessions
problem_type: architecture
component: session_spawning
severity: high
applies_when:
  - Adding any spawn(), execFile(), or tmux session-creation call in src/server/
  - An agent session reports a toolchain that is installed but missing
  - Adding an Environment= line to the systemd unit
tags:
  - environment-variables
  - tmux
  - child-process
  - session-isolation
---

# The guest env boundary

## The rule

**Tinstar is a host for other people's work. A guest process must not inherit
Tinstar's runtime configuration.**

Any spawn of a process that runs a user's code — an agent session, a plugin
server, an editor, a headless `claude` in someone's repo — passes
`guestEnv()` from `src/server/sessions/guestEnv.ts` as its `env`. Node's default
is to hand the child the parent's entire `process.env`, which is what caused
this bug.

Tinstar's *own* services (NATS, observability — anything under
`infra/supervisor.ts`) are not guests. Inheriting is correct there.

## What went wrong

The systemd unit sets `Environment=NODE_ENV=production`, which is correct for
the dashboard's own React build. But:

1. `createTmuxSession` ran `tmux new -d -s …` with default env inheritance.
2. When no tmux server was running, **that call started it** — and tmux freezes
   the starting process's environment as its *server-global* environment.
3. The tmux server is long-lived and shared, so every pane it ever created
   inherited `NODE_ENV=production`.
4. `npm` reads `NODE_ENV`. At `production` it omits devDependencies — while
   printing `added 97 packages`, exit code 0, no warning.

An agent would then have no `tsc`, no `vite`, no test runner, in a repo where
they are correctly declared. The failure is silent: a success message that is a
lie. See
[node-env-production-prunes-devdependencies](../developer-experience/node-env-production-prunes-devdependencies.md)
for the symptom and the `env -u NODE_ENV` workaround; this doc is the source.

`NODE_ENV` was simply the one that got caught. The design fault is scope —
Tinstar treated its own process configuration as ambient machine configuration.

## Allowlist, not denylist

A denylist must be edited every time someone adds an `Environment=` line to the
unit file, and forgetting fails silently — straight back to this bug. The
allowlist fails the other way: an unanticipated variable is withheld, and the
session logs `guest env: withheld N var(s) as Tinstar-private: …`.

**Target: a guest's environment should match what a fresh SSH login gets.**
That is a real oracle, unlike "NODE_ENV is not production".

Dropping a variable is *mostly* safe because **tmux starts pane shells as login
shells** (argv[0] is `-bash`, verified). So for **agent panes**, `.profile` /
`.bashrc` run and re-export PATH additions, version managers, and any tokens the
user exports there. A dropped variable is not lost there — the guest derives it
the way an SSH session would.

### The login-shell caveat — it covers ONE of the six boundaries

That argument does **not** extend to the others, and must not be used to justify
a narrow allowlist for them:

| Boundary | Shell? | Rebuilds dropped vars? |
|---|---|---|
| agent tmux pane | login (`-bash`) | **yes** |
| plugin server (start + health) | `/bin/sh -c` | no |
| editor launch | none | no |
| surfaceAuthor `claude -p` | none | no |
| context-usage probe | none | no |

For four of the five spawn types, whatever is dropped is simply **gone**. That is
why the allowlist carries proxy/TLS (`HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`, …) and
interactive-tool entries a login shell would otherwise have rebuilt — `pam_env`
supplies those to an SSH login from `/etc/environment`, and bash never reads that
file.

### Attribution — only strip what Tinstar could have put there

The tmux server is **shared**. When the *user* started it, its global environment
is their own **login environment** (`NVM_DIR`, `GPG_TTY`, `HTTP_PROXY`, their
exported tokens) — none of which is Tinstar's to remove. Stripping it would make
the agent **poorer than a fresh SSH login**, the exact opposite of the target; and
because the launch line evals `show-environment -s` *after* `.bashrc` has run, it
would actively unset what the login shell just rebuilt.

`tmuxEnvRemovals` therefore removes a name only when it is **also present in
Tinstar's own `process.env`**. A global name Tinstar does not have was not put
there by Tinstar. `NODE_ENV` and friends are in Tinstar's env, so the real leak is
still repaired.

## The audit — what crosses, and why

Tinstar's environment under systemd on the box where this was found (17 vars).

### Allowed

| Variable | Why |
|---|---|
| `HOME` `USER` `LOGNAME` `SHELL` `PATH` `PWD` `MAIL` `TMPDIR` `HOSTNAME` | Core POSIX identity/location. sshd sets these on any login. |
| `TERM` `TZ` `LANG` `LANGUAGE` `LC_*` | Terminal + locale. sshd forwards `LANG`/`LC_*` (`AcceptEnv LANG LC_*`). |
| `XDG_RUNTIME_DIR` `XDG_DATA_DIRS` `XDG_*` `DBUS_SESSION_BUS_ADDRESS` | Established by `pam_systemd` at login. Dropping `XDG_RUNTIME_DIR` breaks keyrings, user sockets, `systemctl --user`. |
| `SSH_AUTH_SOCK` `SSH_AGENT_PID` `DISPLAY` `WAYLAND_DISPLAY` `XAUTHORITY` | Forwarded sockets a real SSH login can carry. An agent needs the agent socket to `git push`. **These are credential-bearing** — see the note below. |
| `HTTP_PROXY` `HTTPS_PROXY` `NO_PROXY` `ALL_PROXY` (+lowercase) `NODE_EXTRA_CA_CERTS` `SSL_CERT_FILE` `SSL_CERT_DIR` `REQUESTS_CA_BUNDLE` | `pam_env` supplies these to an SSH login from `/etc/environment`; bash never reads that file, so no login shell rebuilds them. Withholding them behind a proxy costs a guest all network access with no diagnosable cause. |
| `GPG_TTY` `EDITOR` `VISUAL` `PAGER` `LESS` `COLORTERM` | Interactive-tool plumbing a login shell would have. |
| `TINSTAR_CONFIG_HOME` `TINSTAR_DASHBOARD_URL` `TINSTAR_DATA_DIR` | **Coordination, not private config.** A guest running the `tinstar` CLI must reach the backend that spawned it; without these, a session from a secondary backend or a dev server on 5280 talks to the primary. `TINSTAR_DASHBOARD_URL` is load-bearing for **every** agent skill (`TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-…}"`) and inheritance is its **only** delivery path — nothing injects it. See [agent-skill-backend-url-env-var](./agent-skill-backend-url-env-var.md). |

### Withheld

| Variable | Why |
|---|---|
| `NODE_ENV` | Tinstar's build mode. Breaks `npm install` in unrelated repos. |
| `TINSTAR_CORS_ORIGINS` | Dashboard HTTP config. Meaningless to a guest. |
| `INVOCATION_ID` `JOURNAL_STREAM` `MANAGERPID` `SYSTEMD_EXEC_PID` | Identify *Tinstar's* systemd unit instance. A guest inheriting these misreports itself to systemd tooling. |
| `SHLVL` | Shell-nesting depth from the `bash -c` wrapper in `ExecStart`. |
| everything else | Withheld by default — that is the point of the allowlist. |

### Platform scope — the list is not one list

The table above is the **Linux/systemd** allowlist, derived from what sshd + PAM
actually provide on this host (`/etc/environment`, `AcceptEnv` in
`sshd_config`, `pam_env`, `pam_systemd`). Tinstar also ships macOS and Windows
builds (`.github/workflows/release.yml` builds all three), and
`api/pluginServers.ts` plus the editor launch run on all of them. A
Linux-derived list is **wrong** on the other two:

- **macOS** additionally needs `SECURITYSESSIONID` — it scopes Keychain access,
  so a guest without it loses the git credential helper and every keychain
  lookup — plus `__CF_USER_TEXT_ENCODING` (non-ASCII handling), `XPC_FLAGS`,
  `XPC_SERVICE_NAME`, `Apple_PubSub_Socket_Render`, `COMMAND_MODE`.
- **Windows** shares almost nothing with POSIX. Without `SystemRoot` Node's
  crypto fails; without `PATHEXT` `.cmd`/`.exe` don't resolve; without `ComSpec`
  the shell used by `spawn({shell:true})` is gone. It also needs `USERPROFILE`,
  `APPDATA`, `LOCALAPPDATA`, `TEMP`/`TMP`, and the `Program*` roots.

`guestEnvAllowList(platform)` merges the platform set onto the shared base.
Each platform list is kept separate rather than unioned, so one platform's
plumbing never silently becomes another's allowance.

**Windows names are case-insensitive**, and Node reports them in native casing —
`Path`, not `PATH`. A case-sensitive comparison therefore never matches, and the
first version of this module stripped `PATH` itself from every Windows guest.
`isGuestEnvAllowed` compares case-insensitively on `win32` and exactly
elsewhere, where `path` genuinely differs from `PATH`.

> **This list is a hygiene / blast-radius boundary, NOT containment.** A guest with
> `SSH_AUTH_SOCK` authenticates as the user to every host the agent holds keys for;
> `DBUS_SESSION_BUS_ADDRESS` reaches the unlocked keyring via `org.freedesktop.secrets`;
> `XAUTHORITY`+`DISPLAY` reach the X server. Keeping them is the right call — guests
> previously inherited *everything*, agents genuinely need them, and a same-uid guest can
> find these sockets on disk anyway, so withholding buys no real containment. But the
> "matches a fresh SSH login" oracle is a **compatibility** property, not a safety one.
> Do not cite it to justify the next addition as if it were a security argument.
>
> Also withheld and worth knowing: proxy/CA variables were originally stripped, which
> *is* removing a security control. They are now allowed for exactly that reason.

**Deliberately not synthesized:** `SSH_CLIENT` / `SSH_CONNECTION` / `SSH_TTY`.
There is no SSH connection behind a Tinstar session; inventing them would be its
own kind of lie. This is the one intentional gap from true SSH parity.

**Not inherited, injected:** `TINSTAR_SESSION_NAME`, NATS coordination vars,
OTLP telemetry vars, and per-session secrets are set explicitly via
`tmux set-environment`. That keeps them additive and auditable, which is why
they are absent from the allowlist without being lost.

## Boundaries fixed

| Site | Spawns |
|---|---|
| `sessions/backends/tmux.ts` `tmux new` | the tmux server → every agent pane (**root cause**) |
| `sessions/backends/tmux.ts` `spawn('ttyd')` | terminal-over-web; also the tmux *client* that attaches |
| `api/pluginServers.ts` | third-party plugin servers with their own toolchains |
| `api/routes.ts` editor launch | **longest reach** — the editor outlives the request and its integrated terminals inherit, outside tmux where no later fix reaches |
| `sessions/surfaceAuthor.ts` | headless `claude` in a run's workdir |
| `sessions/context-usage.ts` | context-usage probe |

Not changed: `infra/supervisor.ts` (Tinstar's own services), `execCommand.ts`,
`commits.ts`, `status-watcher.ts`, `binaries.ts`,
`surfaces/witness-runtime.ts` (internal tooling — git, `pgrep`, version probes,
the `unit-landed` Surface witness).

### The witness runtime is on the internal-tooling side, deliberately

`surfaces/witness-runtime.ts` runs `git fetch` / `git log` against a worktree
Tinstar already tracks, to answer a Surface's own claim about whether a plan unit
has landed. It is **host tooling**, not a guest running somebody's code — the same
side of the line as `commits.ts` and `status-watcher.ts`, and it inherits for the
same reason.

Routing it through `guestEnv()` would be actively worse, not merely unnecessary:
the allowlist exists to stop *Tinstar's* configuration reaching *someone else's*
process, and here there is no someone else. A witness spawn is not a shell, so
nothing rebuilds what is dropped (the "not a login shell" row of the table above),
and `git fetch` over SSH needs `SSH_AUTH_SOCK` and the proxy/CA variables — which
the allowlist does carry, so the only thing withholding them would buy is a
witness that reports `unresolved` behind a proxy. The credentials being withheld
would be the host's own.

The argv is still built from **untrusted** input — claim parameters arrive from an
agent-authored file. That is handled where it belongs, in the witness registry's
parameter schema: the plan path must match `docs/plans/<file>.md`, the ref must be
`<remote>/<branch>`, nothing may begin with `-`, and every spawn is an argv array
with no shell. Env inheritance and argv hygiene are different problems.

## tmux specifics — verify, don't reason

The tmux server is long-lived and **shared with tmux sessions the user started
themselves**. Its global environment was frozen when it started, so scoping the
env passed to `tmux new` only helps when that call is what starts the server.

Empirically established (tmux 3.2a):

- `tmux show-environment -g` is exactly what a new pane inherits — verified by
  diffing it against a live pane's `/proc/<pid>/environ`.
- `set-environment -t <session> -r NAME` marks a var for removal **for that
  session only**, and works on an already-running, already-polluted server. No
  restart needed. Tinstar therefore never mutates the user's own sessions.
- An already-running pane keeps the stale value (a process's env is frozen at
  exec), but the launch line already starts with
  `eval "$(tmux show-environment -s)"`, and `-r` makes that emit `unset NAME;` —
  so the live shell is corrected too.
- Removals batch into one invocation with `;` separators.

### The trap: never `-r` a session-scoped var

`show-environment -t <session>` lists **only** session-scoped entries, never
inherited global ones. That makes it a self-maintaining exclusion set covering
secrets whose names come from config and can't be hardcoded.

This is load-bearing on the restart path. When Tinstar itself runs inside a
Tinstar session, the *parent's* `TINSTAR_SESSION_NAME` and secrets sit in the
global env. Removing those names blindly replaces the child's own session-scoped
values with removal markers — the pane ends up with **no** `TINSTAR_SESSION_NAME`
at all. Verified, and covered by a test.

Order matters in `createTmuxSession`: the scrub runs **after** the deliberate
injections, so they are session-scoped by then and thus excluded.

### Isolation when testing tmux

Use `-L <socket>`. **`TMUX_TMPDIR` does not isolate when `$TMUX` is set** — a
tmux client with `$TMUX` set uses that socket and ignores `TMUX_TMPDIR`. Since
agents run inside tmux, a test relying on `TMUX_TMPDIR` operates on the real
server. A `kill-server` without `-L` killed the developer's live sessions during
this investigation.

`TMUX_TMPDIR` is deliberately absent from the allowlist but passed through to
tmux client spawns via `tmuxClientEnv()` — otherwise Tinstar would create
sessions on one socket and look for them on another.

## Tests

- `sessions/__tests__/guestEnv.test.ts` — allowlist policy, incl. a case for a
  variable nobody has added to the unit file yet.
- `sessions/backends/__tests__/guestEnv.tmux.test.ts` — acceptance, against a
  **real** tmux session's **real** shell env. Asserts `NODE_ENV` is *absent*,
  not merely non-production. Includes a deliberately-leaky control case so the
  suite can't pass vacuously.

## Related

- `docs/solutions/conventions/route-tests-inherit-the-real-config-root.md` — the same
  failure genus one layer in. This doc's `kill-server` anecdote (a test that killed the
  developer's live tmux sessions) and that one (a test that rewrote the developer's stored
  reach preference) are the same lesson reached twice by different routes: a child process
  inheriting the parent's environment, versus a test inheriting a process-global config
  path. Both conclude that isolation must be structural, because the failure mode is
  forgetting.
