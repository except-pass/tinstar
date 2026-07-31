// The real dependencies the witness registry runs against (plan U2).
//
// Kept apart from `witness-registry.ts` so that module stays import-pure and the
// pure trigger matcher can import `validateClaim` from it without dragging
// subprocess spawns and HTTP along. This file is the only one in the pair that
// touches either, and nothing imports it except the wiring.
//
// THE REPO WITNESS IS HOST TOOLING, NOT A GUEST. It runs Tinstar's own `git` against
// a worktree Tinstar already tracks — it is not a guest running a user's code, so it
// does NOT go through `guestEnv()`. `docs/solutions/conventions/guest-env-boundary.md`
// draws exactly this line and lists `commits.ts` and `status-watcher.ts` on this side
// of it; routing a `git fetch` through the guest allowlist would withhold
// `SSH_AUTH_SOCK` and the proxy/CA variables from the one call that needs them, and
// buy no isolation, because the credentials it would be withholding are the host's
// own.
//
// Server-only and React-free.

import { execCommand } from '../infra/execCommand'
import type { WitnessDeps } from './witness-registry'

/**
 * The shipped deps.
 *
 * `signal` is accepted and deliberately not forwarded to `execCommand`, which has no
 * signal parameter: the subprocess is bounded by its OWN `timeoutMs` (the same budget
 * the witness races against), so an aborted witness leaves behind a git that git
 * itself kills rather than one that runs forever. Wiring an `AbortSignal` through
 * `execCommand` would change a file three other callers share for no behaviour this
 * unit needs.
 */
export function defaultWitnessDeps(): WitnessDeps {
  return {
    exec: (argv, opts) => execCommand(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs }),
    fetch: async (url, init) => {
      const res = await fetch(url, { method: init.method, redirect: init.redirect, signal: init.signal })
      // Narrowed at the boundary: nothing downstream may read a body, so nothing
      // downstream can hold a response open.
      return { status: res.status }
    },
  }
}
