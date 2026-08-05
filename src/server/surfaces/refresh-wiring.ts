// Wire the refresh engine to the real host.
//
// `SurfaceRefreshCoordinator` takes every external effect as a dependency so its
// state machine is testable without tmux, a filesystem, or real time. This module
// is where those dependencies become the actual ones. It lives beside the
// coordinator rather than inside `src/server/index.ts` because `index.ts` is the
// boot sequence and a hundred lines of session plumbing in the middle of it is how
// boot sequences become unreadable.
//
// WHAT THIS MODULE MAY NOT REACH (plan U1, KTD3). It does not import
// `createSession`, `deleteSession`, `findPort`, `releasePort`, `createTmuxSession`,
// `deleteTmuxSession`, `stopManagedTtyd`, or the surface author. That is the whole
// safety cut: the wiring is the ONLY place the coordinator could have acquired a
// session-creating capability, so a coordinator built here structurally cannot
// create one. The remaining tmux reference is `sendPrompt` — handing text to a
// session that already exists, which creates nothing.
//
// Server-only and React-free.

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { promisify } from 'node:util'
import type { SessionStatus, Surface } from '../../domain/types'
import type { Session } from '../sessions/session'
import { parseA2uiContent } from '../../a2ui/schema'
import { shortId } from '../utils/shortId'
import { log } from '../logger'
import type { DocumentStore } from '../stores/document-store'
import { getSession } from '../sessions'
import * as tmuxBackend from '../sessions/backends/tmux'
import type { TinstarConfig } from '../sessions/config'
import type { SurfaceService } from './surface-service'
import { SurfaceRefreshJobStore } from './surface-refresh-jobs'
import {
  SurfaceRefreshCoordinator,
  type RefreshCoordinatorDeps,
  type StagedRefreshResult,
} from './surface-refresh-coordinator'
import { runWitness, witnessTimeoutMs } from './witness-registry'
import { defaultWitnessDeps } from './witness-runtime'

const execFileAsync = promisify(execFile)

/** The host's own ceiling on ONE witness, applied on top of the kind's budget.
 *
 *  A BACKSTOP, NOT A SECOND OPINION: it sits at the slowest budget the registry ships
 *  (`unit-landed`'s 30s for a `git fetch` on a link the host does not control), so it
 *  changes nothing for either kind today and bounds a future kind that declares
 *  something unreasonable. Cutting it tighter would be worse than useless — a witness
 *  stopped by its budget reports `failed`, which means "this claim is broken and
 *  somebody has to edit it", and a slow network is not that. */
const WITNESS_TIMEOUT_MS = 30_000

/** The current HEAD of a worktree, or null when it is not a repo (or git failed).
 *  Returned as opaque EVIDENCE — the coordinator compares it for equality and never
 *  orders it. */
export async function headRevision(workdir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workdir, 'rev-parse', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Parse an executor's staged artifact.
 *
 * VALIDATED HERE, BEFORE THE BARRIER, and that ordering is the point: the executor
 * writes JSON into a file the host owns, and content that would not survive the
 * A2UI schema must be refused as a FAILURE rather than committed. The alternative —
 * letting the service reject it — would leave the attempt looking successful and the
 * Surface unexplained.
 *
 * A file that is present but unparseable is an error result, not "not there yet".
 * Treating it as absent would spin until the attempt timeout on an executor that has
 * already finished and told us so, badly.
 */
export function parseStagedResult(raw: string): StagedRefreshResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { error: `the staged result is not valid JSON (${(err as Error).message})` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'the staged result is not a JSON object' }
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.error === 'string' && obj.error.trim()) return { error: obj.error.trim() }
  const note = typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : undefined
  const headline = typeof obj.headline === 'string' ? obj.headline.trim() : ''
  if (!headline) {
    // No headline means the executor is reporting "nothing to change". A result with
    // a body but no headline is refused rather than half-applied: authored content
    // always carries a headline, and inventing one would put the host's words under
    // the author's byline.
    if (obj.content !== undefined) return { error: 'the staged result has content but no headline' }
    return { ...(note ? { note } : {}) }
  }
  if (obj.content === undefined) return { content: { headline }, ...(note ? { note } : {}) }
  const body = parseA2uiContent(obj.content)
  if (!body) return { error: 'the staged result\'s content is not valid A2UI for the bounded catalog' }
  return { content: { headline, body }, ...(note ? { note } : {}) }
}

/** Session states that mean a PROCESS is actually behind the record. `stopped` is
 *  the one that is not: `reconcileSessionStates` sets it when tmux says the session
 *  is gone and KEEPS the file, and only `deleteSession` ever removes one. */
export const LIVE_SESSION_STATES: readonly SessionStatus[] = [
  'creating', 'running', 'idle', 'needs_attention',
]

/**
 * Is this session record backed by something still alive?
 *
 * LIVENESS MUST MEAN A PROCESS, NOT A RECORD. This used to be `!!getSession(...)` —
 * a `readFileSync` of a JSON record that OUTLIVES its process — and harvest's
 * vanished-executor branch therefore never fired: instead of failing promptly, an
 * attempt spun to the ten-minute timeout with its Surface badged `refreshing` and
 * nothing behind it.
 *
 * It is now also the gate on whether a foreground owner exists at all (R13). An
 * owner that is not live is an honest `unavailable` check, and answering that
 * question off a stale record would report a fresh result as pending forever.
 *
 * `creating` counts as live: a session mid-launch has no tmux process yet and
 * treating that as absent would be a race, not a diagnosis.
 */
export function isLiveSessionRecord(session: Pick<Session, 'state'> | null | undefined): boolean {
  return !!session && LIVE_SESSION_STATES.includes(session.state)
}

export interface RefreshWiringInput {
  cfg: TinstarConfig
  docStore: DocumentStore
  service: SurfaceService
  /** Re-run the source reconciler for one run and await it — the barrier's
   *  re-observation. */
  reobserveRun: (runId: string) => Promise<void>
}

/** Build the coordinator's real host effects; exported as a typed wiring seam. */
export function buildRefreshCoordinatorDeps(
  input: RefreshWiringInput,
): RefreshCoordinatorDeps {
  const { cfg, docStore, service, reobserveRun } = input
  const jobs = SurfaceRefreshJobStore.open(cfg.dirs.root)
  // Built once. The registry's runners take their effects at CALL time, so this is a
  // plain record of two functions and holds nothing open between passes.
  const witnessDeps = defaultWitnessDeps()

  const deps: RefreshCoordinatorDeps = {
    service,
    jobs,
    surfaces: () => docStore.getAllSurfaces(),
    config: () => ({
      attemptTimeoutMs: cfg.refresh.attemptTimeoutMs,
      defaultIntervalMs: cfg.refresh.defaultIntervalMs,
    }),
    now: () => Date.now(),
    newJobId: () => shortId('job'),

    deliverToOwner: async ({ sessionName, prompt }) => {
      if (!getSession(cfg.dirs.sessions, sessionName)) return false
      try {
        // `sendPrompt` serializes per session server-side, so a fan-out of refresh
        // dispatches at one owner cannot interleave its keystrokes.
        await tmuxBackend.sendPrompt(cfg, sessionName, prompt)
        return true
      } catch (err) {
        log.warn('refresh', `owner delivery to ${sessionName} failed: ${(err as Error).message}`)
        return false
      }
    },

    isLiveSession: name => {
      try { return isLiveSessionRecord(getSession(cfg.dirs.sessions, name)) } catch { return false }
    },

    readStaged: async path => {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return null // not written yet — the ordinary case on most sweeps
      }
      return parseStagedResult(raw)
    },

    clearStaged: async path => {
      try { rmSync(path, { force: true }) } catch { /* best effort */ }
    },

    observeSources: async (surface: Surface) => {
      const runId = surface.provenance?.runId
      if (!runId) return
      await reobserveRun(runId)
    },

    buildPrompt: ({ surface, stagingPath }) => refreshDispatchPrompt(surface, stagingPath),

    runWitness: ({ surface, claim }) => runWitness({
      claim,
      // The BOUND worktree first, then provenance — the same order
      // `authorizationProblem` reads them in, so a repo witness can never read a
      // repository a rebuild of the same Surface would refuse to run in. Absent is
      // not an error to pre-empt: the repo kind answers `unresolved`, and the infra
      // kind does not want a worktree at all.
      ...(surface.source?.worktree ?? surface.provenance?.worktreeId
        ? { worktree: (surface.source?.worktree ?? surface.provenance!.worktreeId)! }
        : {}),
      deps: witnessDeps,
      // The kind's own budget, under the host ceiling. A whole pass is that times the
      // number of batches — a minute at worst — and none of it is spent holding the
      // coordinator's serialization key, which is what makes a minute affordable.
      timeoutMs: Math.min(witnessTimeoutMs(claim.witness) ?? WITNESS_TIMEOUT_MS, WITNESS_TIMEOUT_MS),
    }),
  }

  try { mkdirSync(jobs.stagingDir, { recursive: true }) } catch { /* reported by the store */ }
  return deps
}

/** Build the coordinator with the real host effects behind it. */
export function buildRefreshCoordinator(
  input: RefreshWiringInput,
): SurfaceRefreshCoordinator {
  return new SurfaceRefreshCoordinator(buildRefreshCoordinatorDeps(input))
}

/**
 * What the Surface's FOREGROUND OWNER is told to do (KTD4, R13).
 *
 * The one and only way an agent-written Surface is ever rebuilt: handed to a live
 * agent the human is already talking to, once, because that human just navigated to
 * or interacted with the dirty Surface. There is no background recipient and no
 * fallback that creates one — an absent owner is an honest `unavailable` check.
 *
 * The owner is a live agent mid-conversation, so this carries the same standing
 * guardrail every other Slate injection does: an injected note is a note, not a
 * command to drop in-flight work. The recipe is embedded here rather than written
 * to a brief file because delivery goes through `sendPrompt`, which already treats
 * its argument as data rather than interpolating it into a command line.
 */
export function refreshDispatchPrompt(surface: Surface, stagingPath: string): string {
  const recipe = surface.content.recipe
  return [
    `The host scheduled a refresh of your Slate surface "${oneLine(surface.content.headline)}".`,
    ...(surface.freshness.staleReason ? [`It scheduled it because ${surface.freshness.staleReason.detail}.`] : []),
    '',
    ...(recipe
      ? ['Re-run this recipe against the current state of the repository:', oneLine(recipe)]
      : ['Re-derive that surface from its sources.']),
    '',
    'Write the result as JSON to this exact path (NOT into .tinstar/slate — the host commits it',
    'itself after re-checking the sources):',
    stagingPath,
    '  { "headline": "<one line>", "content": { …A2UI… }, "note": "<optional>" }',
    '  { "note": "no change" }            ← you looked and nothing needed updating',
    '  { "error": "<what stopped you>" }  ← you could not do it',
    '',
    'This is a note on the run\'s Slate, not a command to drop what you are doing — ' +
    'finish or checkpoint your in-flight work first, then act on it.',
  ].join('\n')
}

/** Collapse untrusted text to one line before embedding it in a delivered prompt,
 *  exactly as every other Slate prompt builder does: a multi-line "SYSTEM: …"
 *  headline or recipe could otherwise plant a directive past the guardrail. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
