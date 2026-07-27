/**
 * Environment scoping at the guest boundary.
 *
 * Tinstar is a HOST for other people's work. A session working on an unrelated
 * repo is not part of Tinstar's runtime and must not inherit Tinstar's runtime
 * configuration. Before this module existed, every spawn path used Node's
 * default env inheritance, so Tinstar's own `process.env` flowed straight into
 * guest processes.
 *
 * The concrete damage that surfaced first: the systemd unit sets
 * `Environment=NODE_ENV=production` (correct for the dashboard's own React
 * build). tmux froze that into its server-global environment, every agent pane
 * inherited it, and `npm install` silently omitted devDependencies — reporting
 * "added 97 packages", exit 0, no warning, with no tsc/vite/vitest installed.
 * A success message that is a lie.
 *
 * TARGET: a guest process's environment should match what it would get from a
 * fresh SSH login to this machine — no more, no less. That is a real oracle we
 * can test against, unlike "NODE_ENV is not 'production'".
 *
 * WHY AN ALLOWLIST. A denylist has to be updated every time someone adds an
 * `Environment=` line to the unit file, and the failure mode of forgetting is
 * silent. The allowlist below fails the other way: a variable nobody
 * anticipated is dropped, and `describeGuestEnvScoping()` says so in the log.
 *
 * WHY DROPPING IS MOSTLY SAFE — AND THE LOGIN SHELL CAVEAT. tmux starts pane
 * shells as login shells (argv[0] is `-bash`, verified), so for AGENT PANES
 * `.profile` / `.bashrc` run and re-export PATH additions, version managers,
 * and any tokens the user exports there. A dropped variable is not lost there;
 * the guest derives it the way an SSH session would.
 *
 * That argument does NOT extend to the other boundaries, and it must not be
 * used to justify a narrow allowlist for them:
 *   - plugin servers  — `spawn(cmd, { shell: true })` runs `/bin/sh -c`, a
 *                       NON-login, NON-interactive shell. Nothing is sourced.
 *   - editor launch   — spawned with no shell at all.
 *   - surfaceAuthor / context-usage — `claude` spawned directly, no shell.
 * For those four, whatever is dropped is simply GONE. That is why this list
 * carries proxy/TLS and interactive-tool entries that a login shell would
 * otherwise have rebuilt.
 *
 * NOT SYNTHESIZED: SSH_CLIENT / SSH_CONNECTION / SSH_TTY. There is no SSH
 * connection behind a Tinstar session, and inventing those values would be its
 * own kind of lie. This is the one deliberate gap from true SSH parity.
 *
 * Tinstar's own coordination variables (session identity, NATS subjects, OTLP
 * telemetry, per-session secrets) do NOT ride in through inheritance — they are
 * injected explicitly via `tmux set-environment` at session creation, which
 * keeps them additive and auditable. That is why they are absent from the
 * allowlist without being lost.
 */

/**
 * Exact variable names a guest inherits. Everything here is either part of the
 * environment sshd + PAM hand a login shell, or is required for a guest to
 * coordinate back with the Tinstar backend that spawned it.
 *
 * PLATFORM SCOPE. This list is POSIX/Linux-shaped: it was derived from what
 * sshd + PAM actually provide (/etc/environment, /etc/ssh/sshd_config's
 * `AcceptEnv`, pam_env, pam_systemd). Tinstar also ships macOS and Windows
 * builds (see .github/workflows/release.yml), where a "login environment" is a
 * different set entirely — so the platform lists below are merged in. Without
 * them, `guestEnv()` on Windows strips SystemRoot/PATHEXT/USERPROFILE and even
 * PATH itself, which breaks plugin servers and the editor launch outright.
 */
export const GUEST_ENV_ALLOW_EXACT: readonly string[] = [
  // --- Core POSIX identity / location. sshd sets these directly. ---
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'PWD',
  'MAIL',
  'TMPDIR',
  'HOSTNAME',

  // --- Terminal + locale. TERM is normally replaced by tmux for its panes;
  // it is allowed so non-tmux guests (plugin servers, editors) still get one.
  'TERM',
  'TZ',
  'LANG',
  'LANGUAGE',

  // --- Desktop/session plumbing that pam_systemd establishes at login.
  // Dropping XDG_RUNTIME_DIR in particular breaks anything using per-user
  // runtime state (keyrings, sockets, systemctl --user).
  'XDG_RUNTIME_DIR',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_CLASS',
  'XDG_SEAT',
  'XDG_VTNR',
  'DBUS_SESSION_BUS_ADDRESS',

  // --- Forwarded-credential / display sockets a real SSH login can carry.
  // An agent that needs to `git push` over SSH needs the agent socket.
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',

  // --- Proxy / TLS trust. pam_env hands these to a real SSH login, and four of
  // the six guest boundaries have NO login shell to rebuild them (see the
  // LOGIN SHELL CAVEAT above). Withholding them behind a corporate proxy costs
  // a guest all network access, with no diagnosable cause.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',

  // --- Interactive-tool plumbing a login shell would have.
  'GPG_TTY', 'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'COLORTERM',

  // --- Tinstar coordination. NOT private runtime config: a guest that runs the
  // `tinstar` CLI must reach the SAME backend that spawned it. Without these a
  // session spawned by a secondary backend (TINSTAR_CONFIG_HOME set, see
  // docs/conventions.md) or a dev server on 5280 would silently talk to the
  // primary on 5273 instead.
  //
  // TINSTAR_DASHBOARD_URL is load-bearing for EVERY agent skill: they all open
  // with `TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"` (see
  // agent-skills/skills/*/SKILL.md and
  // docs/solutions/conventions/agent-skill-backend-url-env-var.md). Plain env
  // inheritance is its ONLY delivery path — nothing injects it explicitly — so
  // withholding it silently points every skill at the default backend.
  'TINSTAR_CONFIG_HOME',
  'TINSTAR_DASHBOARD_URL',
  'TINSTAR_DATA_DIR',   // legacy alias for the config root; same reasoning
]

/**
 * macOS additions. A launchd/loginwindow session provides these, and they are
 * the macOS equivalent of the XDG/DBUS plumbing above — not Tinstar's config.
 *
 * SECURITYSESSIONID is the load-bearing one: it scopes Keychain access, so a
 * guest without it loses the git credential helper and any keychain lookup.
 */
export const GUEST_ENV_ALLOW_DARWIN: readonly string[] = [
  'SECURITYSESSIONID',          // Keychain / Security framework session
  '__CF_USER_TEXT_ENCODING',    // CoreFoundation text encoding; absence mangles non-ASCII
  'XPC_FLAGS',                  // launchd service plumbing
  'XPC_SERVICE_NAME',
  'Apple_PubSub_Socket_Render', // per-session pubsub socket
  'COMMAND_MODE',               // set by the macOS login environment
  'LaunchInstanceID',
  '__CFBundleIdentifier',
]

/**
 * Windows additions. Windows has no notion of an SSH login environment, so the
 * reference is "what a user's cmd/PowerShell session has". Several of these are
 * not optional: Node itself needs SystemRoot for crypto, PATHEXT is what makes
 * `.cmd`/`.exe` resolvable, and ComSpec is the shell `spawn({shell:true})` uses.
 */
export const GUEST_ENV_ALLOW_WIN32: readonly string[] = [
  // OS install + shell resolution — omitting these breaks process spawning
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'DriverData',
  // user identity + profile locations (the Windows analogue of HOME)
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE', 'LOGONSERVER', 'COMPUTERNAME', 'SESSIONNAME',
  // app data roots — where toolchains keep caches and config
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  // temp + machine facts
  'TEMP', 'TMP', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
]

/** The allowlist for a given platform. `process.platform` values. */
export function guestEnvAllowList(platform: string = process.platform): readonly string[] {
  if (platform === 'darwin') return [...GUEST_ENV_ALLOW_EXACT, ...GUEST_ENV_ALLOW_DARWIN]
  if (platform === 'win32') return [...GUEST_ENV_ALLOW_EXACT, ...GUEST_ENV_ALLOW_WIN32]
  return GUEST_ENV_ALLOW_EXACT
}

/**
 * Patterned allowances. `LC_*` is forwarded by sshd (`AcceptEnv LANG LC_*` in
 * the default sshd_config), so a login shell legitimately has these.
 */
export const GUEST_ENV_ALLOW_PATTERNS: readonly RegExp[] = [
  /^LC_[A-Z_]+$/,
]

/**
 * True when `name` is allowed to cross the boundary into a guest process.
 *
 * CASE. Windows environment variable names are case-INSENSITIVE, and Node
 * reports them in their native casing — `Path`, not `PATH`; `ProgramFiles`, not
 * `PROGRAMFILES`. A case-sensitive comparison there silently fails to match
 * PATH itself, stripping it from every guest. So the comparison is
 * case-insensitive on win32 and exact everywhere else (where case matters and
 * `path` is genuinely a different variable from `PATH`).
 */
export function isGuestEnvAllowed(name: string, platform: string = process.platform): boolean {
  const allow = guestEnvAllowList(platform)
  if (platform === 'win32') {
    const lower = name.toLowerCase()
    if (allow.some((a) => a.toLowerCase() === lower)) return true
    return GUEST_ENV_ALLOW_PATTERNS.some((re) => re.test(name.toUpperCase()))
  }
  if (allow.includes(name)) return true
  return GUEST_ENV_ALLOW_PATTERNS.some((re) => re.test(name))
}

/**
 * Split an environment into what a guest keeps and what is withheld as
 * Tinstar's private runtime config. `stripped` is sorted so log lines and test
 * assertions are stable.
 */
export function partitionGuestEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): { keep: Record<string, string>; stripped: string[] } {
  const keep: Record<string, string> = {}
  const stripped: string[] = []
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isGuestEnvAllowed(name, platform)) keep[name] = value
    else stripped.push(name)
  }
  return { keep, stripped: stripped.sort() }
}

/**
 * The environment to hand a guest child process. `extra` is layered on top for
 * variables Tinstar injects deliberately (session identity, NATS, telemetry) —
 * those are exempt from the allowlist precisely because they are explicit.
 */
export function guestEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Record<string, string> {
  return { ...partitionGuestEnv(source, platform).keep, ...extra }
}

/**
 * Names to strip from an ALREADY-RUNNING tmux server's environment for one
 * session, via `tmux set-environment -t <session> -r <name>`.
 *
 * Needed because the tmux server is long-lived and shared: its global
 * environment was frozen when it started (from whichever process started it —
 * usually Tinstar), so scoping the env we pass to `tmux new` only helps when
 * that call is what starts the server. For a server that is already up and
 * already polluted, per-session removal is the repair.
 *
 * `-r` marks a variable for removal before any new process is started in that
 * session. It is scoped to the one session, so Tinstar never mutates the
 * environment of tmux sessions the user started themselves.
 *
 * @param globalEnvNames variable names read from `tmux show-environment -g`
 * @param injected       names Tinstar sets deliberately — never remove these
 */
export function tmuxEnvRemovals(
  globalEnvNames: readonly string[],
  injected: readonly string[] = [],
  platform: string = process.platform,
  /** Names present in TINSTAR'S OWN environment — the attribution filter. */
  tinstarEnvNames: readonly string[] = Object.keys(process.env),
): string[] {
  const keepAnyway = new Set(injected)
  const attributable = new Set(tinstarEnvNames)
  return globalEnvNames
    .filter((name) => (
      // Only strip what TINSTAR could have put there. The tmux server is shared:
      // when the USER started it, its global environment is the user's own LOGIN
      // environment (NVM_DIR, GPG_TTY, HTTP_PROXY, their exported tokens), not
      // Tinstar's. Removing those makes the agent POORER than a fresh SSH login
      // — the opposite of this module's target — and, because the launch line
      // evals `show-environment -s` AFTER .bashrc has run, it actively unsets
      // what the login shell just rebuilt.
      //
      // A global name absent from Tinstar's own process.env was not put there by
      // Tinstar, so it is not Tinstar's to remove. NODE_ENV and friends are in
      // Tinstar's env, so the actual leak is still repaired.
      attributable.has(name)
      && !keepAnyway.has(name)
      && !isGuestEnvAllowed(name, platform)
      // Defensive: only ever hand tmux a well-formed variable name. A global
      // name ending in ';' would otherwise be split by tmux's command separator
      // and mark a DIFFERENT variable for removal — a global named `PATH;`
      // emits `-PATH` and leaves new panes with no PATH (verified, tmux 3.2a).
      && VALID_ENV_NAME.test(name)
    ))
    .sort()
}

/** POSIX portable variable name. Anything else is not safe to batch into a
 *  `;`-separated tmux command list, and is not a name we put there anyway. */
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse `tmux show-environment -g` output into variable names.
 *
 * Two line shapes matter:
 *   `NAME=value`  — set in the environment
 *   `-NAME`       — already marked for removal; nothing left to strip
 * Blank lines and anything without a name are ignored.
 */
export function parseTmuxEnvNames(showEnvironmentOutput: string): string[] {
  const names: string[] = []
  for (const line of showEnvironmentOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('-')) continue
    const eq = trimmed.indexOf('=')
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq)
    // Only well-formed names. A VALUE may span lines (an exported bash function
    // is the common case), and those continuation lines would otherwise be read
    // as variable names and fed to `set-environment -r` as junk removals.
    if (name && VALID_ENV_NAME.test(name)) names.push(name)
  }
  return names
}

/** One-line, greppable summary of what a guest boundary withheld. */
export function describeGuestEnvScoping(stripped: readonly string[]): string {
  if (stripped.length === 0) return 'guest env: nothing withheld'
  return `guest env: withheld ${stripped.length} var(s) as Tinstar-private: ${stripped.join(', ')}`
}

/**
 * `guestEnv()` plus a log line naming what was withheld, tagged with the
 * boundary. Use this at every spawn site rather than bare `guestEnv()`.
 *
 * Withholding a variable a child actually needed produces a failure with no
 * obvious cause — the same shape as the bug this module fixes. The tmux path
 * logs via its own scrub; this gives the four non-tmux boundaries (plugin
 * servers, editor, surfaceAuthor, context-usage) the same breadcrumb at the
 * point of cause. Debug level: routine and noisy, but present when someone
 * goes looking.
 */
export function guestEnvFor(
  boundary: string,
  logDebug: (scope: string, msg: string) => void,
  extra: Record<string, string> = {},
): Record<string, string> {
  const { keep, stripped } = partitionGuestEnv()
  logDebug('guest-env', `${boundary}: ${describeGuestEnvScoping(stripped)}`)
  return { ...keep, ...extra }
}
