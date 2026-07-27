import { describe, it, expect } from 'vitest'
import {
  isGuestEnvAllowed,
  partitionGuestEnv,
  guestEnv,
  tmuxEnvRemovals,
  parseTmuxEnvNames,
  describeGuestEnvScoping,
} from '../guestEnv'

/**
 * The environment Tinstar's own systemd unit gives it on the box where this bug
 * was found. Kept verbatim as the regression fixture: every one of these
 * actually crossed into agent sessions.
 */
const TINSTAR_SYSTEMD_ENV = {
  // ambient, from the user-level service manager — a login shell has these too
  HOME: '/home/ubuntu',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  SHELL: '/bin/bash',
  USER: 'ubuntu',
  LOGNAME: 'ubuntu',
  LANG: 'C.UTF-8',
  XDG_DATA_DIRS: '/usr/local/share:/usr/share',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  // Tinstar's private runtime config, from the unit file's Environment= lines
  NODE_ENV: 'production',
  TINSTAR_CORS_ORIGINS: 'tauri://localhost,http://localhost:5273',
  // identifiers for this specific service instance
  INVOCATION_ID: 'b3a1f2c4d5e6',
  JOURNAL_STREAM: '8:12345',
  MANAGERPID: '761',
  SYSTEMD_EXEC_PID: '302140',
  // leftovers from the `bash -c` wrapper in ExecStart
  PWD: '/home/ubuntu/repo/tinstar',
  SHLVL: '1',
}

describe('guest env allowlist', () => {
  it('withholds NODE_ENV — the variable that silently broke npm install', () => {
    // The headline bug: NODE_ENV=production makes `npm install` omit
    // devDependencies while still reporting success, so a guest ends up with no
    // tsc/vite/vitest and no indication anything went wrong.
    expect(isGuestEnvAllowed('NODE_ENV')).toBe(false)
    expect(partitionGuestEnv(TINSTAR_SYSTEMD_ENV).keep).not.toHaveProperty('NODE_ENV')
  })

  it('keeps what a fresh SSH login shell would have', () => {
    const { keep } = partitionGuestEnv(TINSTAR_SYSTEMD_ENV)
    expect(keep).toEqual({
      HOME: '/home/ubuntu',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/bash',
      USER: 'ubuntu',
      LOGNAME: 'ubuntu',
      LANG: 'C.UTF-8',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PWD: '/home/ubuntu/repo/tinstar',
    })
  })

  it('withholds every private variable from the real systemd environment', () => {
    expect(partitionGuestEnv(TINSTAR_SYSTEMD_ENV).stripped).toEqual([
      'INVOCATION_ID',
      'JOURNAL_STREAM',
      'MANAGERPID',
      'NODE_ENV',
      'SHLVL',
      'SYSTEMD_EXEC_PID',
      'TINSTAR_CORS_ORIGINS',
    ])
  })

  it('withholds a variable nobody has added to the unit file yet', () => {
    // The whole reason this is an allowlist and not a denylist. A denylist has
    // to be edited every time someone adds an Environment= line, and forgetting
    // fails silently. This must pass without anyone touching guestEnv.ts.
    const { keep, stripped } = partitionGuestEnv({
      ...TINSTAR_SYSTEMD_ENV,
      SOME_FUTURE_TINSTAR_SETTING: 'whatever',
      ANOTHER_ONE: 'x',
    })
    expect(keep).not.toHaveProperty('SOME_FUTURE_TINSTAR_SETTING')
    expect(keep).not.toHaveProperty('ANOTHER_ONE')
    expect(stripped).toContain('SOME_FUTURE_TINSTAR_SETTING')
    expect(stripped).toContain('ANOTHER_ONE')
  })

  it('keeps forwarded locale variables (sshd AcceptEnv LANG LC_*)', () => {
    const { keep } = partitionGuestEnv({ LC_ALL: 'en_US.UTF-8', LC_TIME: 'en_GB.UTF-8', LCFOO: 'no' })
    expect(keep).toEqual({ LC_ALL: 'en_US.UTF-8', LC_TIME: 'en_GB.UTF-8' })
  })

  it('keeps TINSTAR_CONFIG_HOME so a guest reaches the backend that spawned it', () => {
    // Coordination, not private config: without it a session spawned by a
    // secondary backend would run `tinstar` against the primary instead.
    expect(isGuestEnvAllowed('TINSTAR_CONFIG_HOME')).toBe(true)
    // ...but that allowance is specific, not a blanket TINSTAR_* pass.
    expect(isGuestEnvAllowed('TINSTAR_CORS_ORIGINS')).toBe(false)
    expect(isGuestEnvAllowed('TINSTAR_DASHBOARD_PORT')).toBe(false)
    expect(isGuestEnvAllowed('TINSTAR_FAST_SIM')).toBe(false)
  })

  it('drops undefined values rather than passing them through as "undefined"', () => {
    const { keep } = partitionGuestEnv({ HOME: '/home/ubuntu', TERM: undefined })
    expect(keep).toEqual({ HOME: '/home/ubuntu' })
  })

  it('layers deliberate injections on top of the allowlist', () => {
    // Session identity / NATS / telemetry are injected explicitly, so they are
    // exempt from the allowlist without needing to be in it.
    const env = guestEnv({ TINSTAR_SESSION_NAME: 'my-session' }, TINSTAR_SYSTEMD_ENV)
    expect(env.TINSTAR_SESSION_NAME).toBe('my-session')
    expect(env).not.toHaveProperty('NODE_ENV')
  })
})

describe('cross-platform generalization', () => {
  // Tinstar ships macOS and Windows builds (.github/workflows/release.yml), and
  // pluginServers.ts / the editor launch run on all three. The allowlist was
  // originally derived from a Linux+systemd box, which stripped everything
  // essential on Windows — including PATH itself.

  it('keeps what Windows needs to spawn a process at all', () => {
    // Node needs SystemRoot for crypto; PATHEXT resolves .cmd/.exe; ComSpec is
    // the shell used by spawn({shell:true}) in pluginServers.ts.
    for (const v of ['SystemRoot', 'PATHEXT', 'ComSpec', 'SystemDrive', 'windir']) {
      expect(isGuestEnvAllowed(v, 'win32')).toBe(true)
    }
  })

  it('keeps the Windows profile + app-data roots', () => {
    for (const v of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERNAME', 'ProgramFiles']) {
      expect(isGuestEnvAllowed(v, 'win32')).toBe(true)
    }
  })

  it('matches Windows names case-insensitively — Node reports "Path", not "PATH"', () => {
    // The bug this guards: a case-SENSITIVE check never matches Node's native
    // Windows casing, so PATH was stripped from every guest on Windows.
    expect(isGuestEnvAllowed('Path', 'win32')).toBe(true)
    expect(isGuestEnvAllowed('ProgramData', 'win32')).toBe(true)
    expect(isGuestEnvAllowed('UserProfile', 'win32')).toBe(true)
    // ...but case-sensitive on POSIX, where `path` really is a different var.
    expect(isGuestEnvAllowed('Path', 'linux')).toBe(false)
    expect(isGuestEnvAllowed('PATH', 'linux')).toBe(true)
  })

  it('still withholds Tinstar private config on Windows', () => {
    expect(isGuestEnvAllowed('NODE_ENV', 'win32')).toBe(false)
    expect(isGuestEnvAllowed('TINSTAR_CORS_ORIGINS', 'win32')).toBe(false)
  })

  it('keeps the macOS Keychain session — git credentials depend on it', () => {
    // SECURITYSESSIONID scopes Security-framework access. Without it a guest
    // loses the git credential helper and every keychain lookup.
    expect(isGuestEnvAllowed('SECURITYSESSIONID', 'darwin')).toBe(true)
    expect(isGuestEnvAllowed('__CF_USER_TEXT_ENCODING', 'darwin')).toBe(true)
    expect(isGuestEnvAllowed('XPC_SERVICE_NAME', 'darwin')).toBe(true)
  })

  it('does not leak one platform\'s vars into another', () => {
    // Keeps each list honest rather than a union that never gets pruned.
    expect(isGuestEnvAllowed('SECURITYSESSIONID', 'linux')).toBe(false)
    expect(isGuestEnvAllowed('SystemRoot', 'linux')).toBe(false)
    expect(isGuestEnvAllowed('SECURITYSESSIONID', 'win32')).toBe(false)
  })

  it('keeps the POSIX core on every platform', () => {
    for (const p of ['linux', 'darwin', 'win32']) {
      expect(isGuestEnvAllowed('HOME', p)).toBe(true)
      expect(isGuestEnvAllowed('PATH', p)).toBe(true)
      expect(isGuestEnvAllowed('TINSTAR_CONFIG_HOME', p)).toBe(true)
    }
  })
})

describe('tmux global environment repair', () => {
  it('parses show-environment output, ignoring removal markers', () => {
    const output = [
      'HOME=/home/ubuntu',
      'NODE_ENV=production',
      '-DISPLAY',
      '-SSH_AUTH_SOCK',
      'TINSTAR_CORS_ORIGINS=a,b',
      '',
    ].join('\n')
    expect(parseTmuxEnvNames(output)).toEqual([
      'HOME', 'NODE_ENV', 'TINSTAR_CORS_ORIGINS',
    ])
  })

  it('keeps values containing "=" intact when reading names', () => {
    expect(parseTmuxEnvNames('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus'))
      .toEqual(['DBUS_SESSION_BUS_ADDRESS'])
  })

  it('marks exactly the private variables for removal', () => {
    const names = Object.keys(TINSTAR_SYSTEMD_ENV)
    // Attribution passed EXPLICITLY: the fixture IS Tinstar's own env here.
    // Relying on the default (the runner's process.env) would make this pass or
    // fail depending on whether vitest happens to set NODE_ENV.
    expect(tmuxEnvRemovals(names, [], 'linux', names)).toEqual([
      'INVOCATION_ID',
      'JOURNAL_STREAM',
      'MANAGERPID',
      'NODE_ENV',
      'SHLVL',
      'SYSTEMD_EXEC_PID',
      'TINSTAR_CORS_ORIGINS',
    ])
  })

  it('never removes a variable Tinstar injected deliberately', () => {
    // If Tinstar itself is running inside a Tinstar session, its own
    // TINSTAR_SESSION_NAME is in the global env — removing it would strip the
    // child session's identity.
    const names = ['NODE_ENV', 'TINSTAR_SESSION_NAME', 'OTEL_METRICS_EXPORTER']
    const removals = tmuxEnvRemovals(
      names,
      ['TINSTAR_SESSION_NAME', 'OTEL_METRICS_EXPORTER'],
      'linux',
      names,
    )
    expect(removals).toEqual(['NODE_ENV'])
  })

  it('asks for no removals when the global environment is already clean', () => {
    const clean = ['HOME', 'PATH', 'USER', 'LANG']
    expect(tmuxEnvRemovals(clean, [], 'linux', clean)).toEqual([])
  })
})

describe('attribution — only strip what Tinstar could have put there', () => {
  // The tmux server is SHARED. When the USER started it, its global environment
  // is their own LOGIN environment, and none of it is Tinstar's to remove.
  // Removing it makes the agent poorer than a fresh SSH login — the opposite of
  // this module's target — and, because the launch line evals
  // `show-environment -s` AFTER .bashrc has run, actively unsets what the login
  // shell just rebuilt.
  const USER_LOGIN_ENV = ['HOME', 'PATH', 'USER', 'NVM_DIR', 'BUN_INSTALL', 'GPG_TTY', 'JIRA_TOKEN']
  const TINSTAR_ENV = ['HOME', 'PATH', 'USER', 'NODE_ENV', 'TINSTAR_CORS_ORIGINS', 'INVOCATION_ID']

  it('removes nothing from a tmux server the USER started', () => {
    expect(tmuxEnvRemovals(USER_LOGIN_ENV, [], 'linux', TINSTAR_ENV)).toEqual([])
  })

  it('still removes Tinstar-private vars from a server TINSTAR started', () => {
    expect(tmuxEnvRemovals(TINSTAR_ENV, [], 'linux', TINSTAR_ENV))
      .toEqual(['INVOCATION_ID', 'NODE_ENV', 'TINSTAR_CORS_ORIGINS'])
  })

  it('strips only the attributable half of a mixed environment', () => {
    // Tinstar started the server while the user's own vars were also present.
    const mixed = [...USER_LOGIN_ENV, 'NODE_ENV', 'TINSTAR_CORS_ORIGINS']
    expect(tmuxEnvRemovals(mixed, [], 'linux', TINSTAR_ENV))
      .toEqual(['NODE_ENV', 'TINSTAR_CORS_ORIGINS'])
    // The user's exported token survives.
    expect(tmuxEnvRemovals(mixed, [], 'linux', TINSTAR_ENV)).not.toContain('JIRA_TOKEN')
  })
})

describe('hostile and malformed variable names', () => {
  it('never hands tmux a name that its command separator would split', () => {
    // `PATH;` would emit the marker `-PATH` after tmux splits on the trailing
    // `;` — removing a DIFFERENT variable than was read, leaving new panes with
    // no PATH (verified, tmux 3.2a). Argv injection itself is blocked by
    // execFile, but mis-targeting is not.
    const names = ['PATH;', 'EVIL;', 'EV IL', 'AB;kill-server', 'OK_NAME']
    const removals = tmuxEnvRemovals(names, [], 'linux', names)
    expect(removals).toEqual(['OK_NAME'])
  })

  it('ignores continuation lines of a multi-line value', () => {
    // An exported bash function spans lines; the continuation lines are NOT
    // variable names and must not become removal targets.
    const output = [
      'HOME=/home/ubuntu',
      'BASH_FUNC_foo%%=() {  echo hi',
      '}',
      'NODE_ENV=production',
    ].join('\n')
    expect(parseTmuxEnvNames(output)).toEqual(['HOME', 'NODE_ENV'])
  })
})

describe('coordination vars every agent skill depends on', () => {
  it('lets TINSTAR_DASHBOARD_URL through — inheritance is its ONLY channel', () => {
    // Every skill opens with TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-localhost:5273}".
    // Nothing injects it explicitly, so withholding it silently points every
    // skill at the default backend. See agent-skill-backend-url-env-var.md.
    expect(isGuestEnvAllowed('TINSTAR_DASHBOARD_URL')).toBe(true)
    expect(isGuestEnvAllowed('TINSTAR_CONFIG_HOME')).toBe(true)
    expect(isGuestEnvAllowed('TINSTAR_DATA_DIR')).toBe(true)
  })

  it('lets proxy and CA-bundle vars through — no login shell rebuilds them', () => {
    // pam_env supplies these from /etc/environment to an SSH login; bash never
    // reads that file, and four of the six boundaries have no shell at all.
    for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy',
                     'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
      expect(isGuestEnvAllowed(v)).toBe(true)
    }
  })
})

describe('operator-visible reporting', () => {
  it('names what it withheld, so a dropped variable is discoverable', () => {
    // A silent strip would be the same class of bug as the one being fixed.
    expect(describeGuestEnvScoping(['NODE_ENV', 'TINSTAR_CORS_ORIGINS']))
      .toBe('guest env: withheld 2 var(s) as Tinstar-private: NODE_ENV, TINSTAR_CORS_ORIGINS')
    expect(describeGuestEnvScoping([])).toBe('guest env: nothing withheld')
  })
})
