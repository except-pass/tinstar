/**
 * The one-time runtime notice for the loopback bind change.
 *
 * A release note alone is not enough here. Tinstar is published and its
 * documented onboarding is `npx tinstar`, so an operator can upgrade into a
 * narrower bind without ever reading one — and the symptom (a LAN URL that
 * stopped answering) looks like a crash, not a decision. This tells them once,
 * at the moment it matters, in the place they are already looking.
 */

/** Bumping the id re-announces; the marker is matched on it, not on presence. */
export const BIND_NOTICE_ID = 'loopback-bind-v1'

export interface BindNoticeStore {
  read(): string | null
  write(value: string): void
}

/**
 * Names the interim opt-in — `--host` — and NOT the reach command. This unit
 * ships with the bind flip, one release ahead of reach, so the reach command
 * does not exist yet; naming a command the operator cannot run would be worse
 * than naming nothing.
 */
export function bindChangeNotice(): string {
  return [
    'Tinstar now binds loopback only by default (127.0.0.1 and ::1).',
    'This is a breaking change: the LAN and tailnet addresses of this host no',
    'longer answer unless you ask for them. http://localhost:<port> is',
    'unchanged, and so is every host-local hook and CLI command.',
    '',
    'To serve another address again, name it explicitly:',
    '    tinstar --host <address>            (127.0.0.1 is always added too)',
    '',
    'Terminals are also loopback-only now, and reachable only through this',
    'server. A terminal left running by an older version is replaced rather',
    'than reused, so existing sessions restart their terminal once.',
  ].join('\n')
}

/**
 * Emit the notice at most once per install. Returns whether it was emitted.
 *
 * `existingInstall` suppresses it for a config root that has never run an
 * older version — a migration notice for a migration that never happened is
 * just noise. The marker is still recorded in that case, so the operator's
 * second start does not look like an upgrade.
 */
export function announceBindChangeOnce(
  store: BindNoticeStore,
  emit: (message: string) => void,
  opts: { existingInstall: boolean },
): boolean {
  let seen: string | null = null
  try {
    seen = store.read()
  } catch {
    // An unreadable marker means we cannot tell; announcing twice is the
    // harmless direction, staying silent forever is not.
  }
  if (seen === BIND_NOTICE_ID) return false

  try {
    store.write(BIND_NOTICE_ID)
  } catch {
    // A read-only config dir must never stop the server from starting.
  }

  if (!opts.existingInstall) return false
  emit(bindChangeNotice())
  return true
}
