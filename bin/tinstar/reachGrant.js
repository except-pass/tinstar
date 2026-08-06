/**
 * The privilege grant that lets Tinstar establish and revoke reach unattended.
 *
 * `tailscale serve` needs privilege, and Tinstar needs it at moments when
 * nobody is present: revoke runs at shutdown, repair runs at boot. So the
 * escalation has to be persistent and non-interactive — an interactive prompt
 * is not a weaker version of this, it is a non-working version.
 *
 * The shape is a sudoers drop-in scoped to the exact two invocations Tinstar
 * issues, chosen over Tailscale's own `--operator` grant and over
 * documented-manual enablement. The operator grant confers control of the whole
 * daemon and is the pivot in one of the advisories this work gates on; manual
 * enablement cannot clean up at shutdown or repair at boot. This rule permits
 * no other subcommand and no wildcard path, so its blast radius is serve-shaped
 * rather than daemon-shaped.
 */

/** A drop-in, never the main sudoers file — removable without editing it. */
export const REACH_SUDOERS_PATH = '/etc/sudoers.d/tinstar-reach'

/**
 * The two commands, verbatim. They must stay byte-identical to what
 * src/server/reach/tailscale.ts issues: sudoers matches the full command line,
 * so a single extra flag turns the grant into a silent no-permission failure.
 */
export function reachGrantCommands({ tailscalePath, port }) {
  return [
    `${tailscalePath} serve --bg --yes --https=443 http://127.0.0.1:${port}`,
    `${tailscalePath} serve --bg --yes --https=443 off`,
  ]
}

export function buildReachSudoersRule({ user, tailscalePath, port }) {
  const commands = reachGrantCommands({ tailscalePath, port }).join(', ')
  return `${user} ALL=(root) NOPASSWD: ${commands}`
}

/**
 * Whether the rule permits a given command line. Exact-match only, mirroring
 * how sudoers treats a command with no wildcard — this exists so the scoping
 * can be asserted rather than asserted about.
 */
export function grantPermits(rule, commandLine) {
  const body = rule.slice(rule.indexOf('NOPASSWD:') + 'NOPASSWD:'.length)
  return body.split(',').map(c => c.trim()).includes(commandLine.trim())
}

/**
 * What the operator reads before anything is written. This is a root-adjacent
 * rule on a machine running autonomous agents; it should never appear on a
 * system without a human having seen its literal text.
 */
export function describeReachGrant({ user, tailscalePath, port }) {
  const rule = buildReachSudoersRule({ user, tailscalePath, port })
  return [
    `About to write ${REACH_SUDOERS_PATH}:`,
    '',
    `    ${rule}`,
    '',
    `This lets ${user} run those two commands — and only those two — as root`,
    'without a password. It permits no other tailscale subcommand: not `up`,',
    'not `down`, not `serve reset`, not `set --operator`. There is no wildcard',
    'in it, so nothing else on this machine gains anything.',
    '',
    `It is scoped to port ${port}. If Tinstar ever binds a different port (the`,
    'listener walks past a busy one), reach is refused until you re-run the',
    'install for the new port — the grant will not silently widen to cover it.',
    '',
    `Remove it at any time with: sudo rm ${REACH_SUDOERS_PATH}`,
  ].join('\n')
}

/**
 * A unit generated before the loopback default pins a tailnet IP into
 * ExecStart and freezes a CORS allowlist at install time. Both are now the
 * reach adapter's to own, and a pinned tailnet address in particular re-opens
 * the bind that containment closed — so an old unit silently undoes this work.
 */
export function unitNeedsRegeneration(unitText) {
  if (!unitText) return { needsRegeneration: false, reasons: [] }
  const reasons = []
  if (/tailscale ip/.test(unitText)) {
    reasons.push('it pins a tailnet address into --host, which re-opens the bind containment closed')
  }
  if (/TINSTAR_CORS_ORIGINS=/.test(unitText)) {
    reasons.push('it freezes a CORS allowlist at install time, which the server now seeds at bind')
  }
  return { needsRegeneration: reasons.length > 0, reasons }
}
