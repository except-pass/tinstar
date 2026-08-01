// Wire the refresh engine to the real host (plan U6).
//
// `SurfaceRefreshCoordinator` takes every external effect as a dependency so its
// state machine is testable without tmux, a filesystem, or real time. This module
// is where those dependencies become the actual ones. It lives beside the
// coordinator rather than inside `src/server/index.ts` because `index.ts` is the
// boot sequence and a hundred lines of session plumbing in the middle of it is how
// boot sequences become unreadable — the plan lists `index.ts` in this unit's
// Files, and it gets the eight lines that construct this.
//
// Server-only and React-free.

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { SessionStatus, Surface } from '../../domain/types'
import type { Session } from '../sessions/session'
import { parseA2uiContent } from '../../a2ui/schema'
import { shortId } from '../utils/shortId'
import { log } from '../logger'
import type { DocumentStore } from '../stores/document-store'
import { getSession, loadSecrets, updateSession, deleteSession, createSession } from '../sessions'
import * as tmuxBackend from '../sessions/backends/tmux'
import { refreshConfigProblem, type TinstarConfig } from '../sessions/config'
import { launchRefreshWorker } from '../sessions/surfaceAuthor'
import { defaultProviderRegistry } from '../providers/lifecycle'
import type { SurfaceService } from './surface-service'
import { SurfaceRefreshJobStore } from './surface-refresh-jobs'
import {
  SurfaceRefreshCoordinator,
  type RefreshCoordinatorDeps,
  type StagedRefreshResult,
} from './surface-refresh-coordinator'

const execFileAsync = promisify(execFile)

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
 * Parse a worker's staged artifact.
 *
 * VALIDATED HERE, BEFORE THE BARRIER, and that ordering is the point: a worker
 * writes JSON into a file the host owns, and content that would not survive the
 * A2UI schema must be refused as a FAILURE rather than committed. The alternative —
 * letting the service reject it — would leave the job looking successful and the
 * Surface unexplained.
 *
 * A file that is present but unparseable is an error result, not "not there yet".
 * Treating it as absent would spin until the worker timeout on a worker that has
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
    // No headline means the worker is reporting "nothing to change". A result with
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
 * This used to be `!!getSession(...)` — a `readFileSync` of a JSON record that
 * OUTLIVES its process. Two things broke as a result. Harvest's vanished-worker
 * branch never fired, so instead of failing promptly a job spun to the ten-minute
 * timeout with its Surface badged `refreshing` and nothing behind it — precisely
 * what that branch's own comment says it prevents. And `recover()` adopted a worker
 * that died with the host and renewed its lease, contradicting the documented
 * contract that a job whose worker did not survive the restart is failed.
 *
 * `creating` counts as live: a session mid-launch has no tmux process yet and
 * failing its job for that would be a race, not a diagnosis.
 */
export function isLiveSessionRecord(session: Pick<Session, 'state'> | null | undefined): boolean {
  return !!session && LIVE_SESSION_STATES.includes(session.state)
}

/**
 * Take a finished refresh worker down and give back everything it held.
 *
 * RETIRE, NOT DELETE: the worker's transcript is evidence about a refresh that
 * ran, and the normal Graveyard path is what keeps it reachable.
 *
 * THE PORT IS THE PART THAT WAS MISSING, and it is why this is a named function
 * with seams rather than a closure. `tmuxBackend.claimedPorts` is an in-process Set
 * that ONLY `releasePort` shrinks — stopping the ttyd and deleting the session do
 * not touch it. So every SUCCESSFUL refresh permanently consumed one port from the
 * refresh window, and after as many refreshes as the window is wide, every
 * automatic refresh failed with "No available port found" until the backend was
 * restarted. The only `releasePort` anywhere on this path was launch-failure
 * compensation: a refresh that BROKE gave its port back and one that WORKED did
 * not.
 *
 * ORDER IS LOAD-BEARING at one point only: the session record has to be read for
 * its port BEFORE `deleteSession` removes it. Everything else is best-effort, and
 * a step that throws must not strand the ones after it — half a retirement is how
 * the leak looked in the first place.
 */
export async function retireRefreshWorker(input: {
  name: string
  getSession: () => { port: number | null } | null
  stopTtyd: () => void
  deleteTmux: (session: { port: number | null }) => Promise<void>
  deleteRun: () => void
  deleteSession: () => void
  releasePort: (port: number) => void
}): Promise<void> {
  try { input.stopTtyd() } catch { /* already gone */ }
  const session = input.getSession()
  if (session) {
    try { await input.deleteTmux(session) } catch { /* already gone */ }
  }
  try { input.deleteRun() } catch { /* already gone */ }
  try { input.deleteSession() } catch { /* already gone */ }
  if (session?.port) {
    try { input.releasePort(session.port) } catch { /* best effort */ }
  }
}

export interface RefreshWiringInput {
  cfg: TinstarConfig
  docStore: DocumentStore
  service: SurfaceService
  /** Re-run the source reconciler for one run and await it — the barrier's
   *  re-observation. */
  reobserveRun: (runId: string) => Promise<void>
}

export interface RefreshWorkerTerminalStops {
  compensateLaunch: (name: string) => void
  retire: (name: string) => void
}

export function buildRefreshWorkerTerminalStops(
  stopManagedTtyd: typeof tmuxBackend.stopManagedTtyd
    = tmuxBackend.stopManagedTtyd,
): RefreshWorkerTerminalStops {
  return {
    compensateLaunch: name => stopManagedTtyd(name, {
      cancellationReason: 'surface refresh launch compensation',
    }),
    retire: name => stopManagedTtyd(name, {
      cancellationReason: 'surface refresh retirement',
    }),
  }
}

/** Build the coordinator's real host effects; exported as a typed wiring seam. */
export function buildRefreshCoordinatorDeps(
  input: RefreshWiringInput,
): RefreshCoordinatorDeps {
  const { cfg, docStore, service, reobserveRun } = input
  const jobs = SurfaceRefreshJobStore.open(cfg.dirs.root)
  const terminalStops = buildRefreshWorkerTerminalStops()
  // A broken port/cap config degrades the engine to owner delivery rather than
  // stopping it: freshness still tracks, jobs still queue, and a live owner still
  // gets the work — only the background fleet is withheld, which is the part the
  // broken setting would have made unsafe.
  const problem = refreshConfigProblem(cfg)

  const deps: RefreshCoordinatorDeps = {
    service,
    jobs,
    surfaces: () => docStore.getAllSurfaces(),
    config: () => ({
      maxConcurrentWorkers: cfg.refresh.maxConcurrentWorkers,
      workerTimeoutMs: cfg.refresh.workerTimeoutMs,
      defaultIntervalMs: cfg.refresh.defaultIntervalMs,
      autonomousWorkers: cfg.refresh.autonomousWorkers && !problem,
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

    sessionIncarnation: name => {
      try {
        const session = getSession(cfg.dirs.sessions, name)
        // Exactly what `launchRefreshWorker` stamped, or the two disagree and every
        // adoption fails. A session with no conversation id falls back to its
        // creation stamp there, so it falls back to the same thing here.
        return session ? session.conversation.id ?? session.created : undefined
      } catch { return undefined }
    },

    launchWorker: async ({ job, surface }) => {
      const worktree = job.worktree
      if (!worktree) return { ok: false, message: 'no worktree is recorded for this Surface' }
      const recipe = surface.content.recipe
      if (!recipe) return { ok: false, message: 'this Surface declares no refresh recipe' }
      const provider = defaultProviderRegistry.resolveTemplate(null)
      const result = await launchRefreshWorker({
        config: cfg,
        worktree,
        sessionName: `refresh-${job.id}`,
        briefPath: `${job.stagingPath}.brief.md`,
        stagingPath: job.stagingPath,
        recipe,
        headline: surface.content.headline,
        providerAdapter: provider.provider.id,
        secrets: loadSecrets(cfg.dirs.secrets),
        spaceId: surface.spaceId,
        writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
        removeFile: path => { try { rmSync(path, { force: true }) } catch { /* best effort */ } },
        findPort: window => tmuxBackend.findPort(window),
        releasePort: port => tmuxBackend.releasePort(port),
        createSession,
        deleteSession,
        updateSession,
        startSession: ({ session, port, secrets }) =>
          tmuxBackend.createTmuxSession(cfg, {
            session,
            secrets,
            port,
            template: null,
            provider,
          }),
        stopSession: terminalStops.compensateLaunch,
        // A cast, because the launcher takes the run shape as an opaque record —
        // it may not import the Run type without dragging the whole document model
        // into the sessions layer. The fields it actually builds are asserted by
        // `refresh-wiring.test.ts` rather than by the compiler.
        upsertRun: (id, run) => docStore.upsertRun(id, run as unknown as Parameters<DocumentStore['upsertRun']>[1]),
        deleteRun: id => docStore.deleteRun(id),
      })
      return result.ok
        ? {
          ok: true,
          sessionName: result.incarnation.name,
          // CARRIED, not discarded. The launcher has built this all along and this
          // line threw it away, which left `recover()`'s documented "only if the
          // incarnation it recorded is still live" implemented nowhere.
          incarnation: result.incarnation.incarnation,
        }
        : { ok: false, message: result.message }
    },

    retireWorker: name => retireRefreshWorker({
      name,
      getSession: () => getSession(cfg.dirs.sessions, name),
      stopTtyd: () => terminalStops.retire(name),
      deleteTmux: session => tmuxBackend.deleteTmuxSession(cfg, session as Session),
      deleteRun: () => docStore.deleteRun(name),
      deleteSession: () => { deleteSession(cfg.dirs.sessions, name) },
      releasePort: port => tmuxBackend.releasePort(port),
    }),

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
      try { rmSync(`${path}.brief.md`, { force: true }) } catch { /* best effort */ }
    },

    observeSources: async (surface: Surface) => {
      const runId = surface.provenance?.runId
      if (!runId) return
      await reobserveRun(runId)
    },

    buildPrompt: ({ surface, stagingPath }) => refreshDispatchPrompt(surface, stagingPath),
  }

  try { mkdirSync(jobs.stagingDir, { recursive: true }) } catch { /* reported by the store */ }
  if (problem) log.warn('refresh', `background refresh workers disabled — ${problem}`)
  return deps
}

/** Build the coordinator with the real host effects behind it. */
export function buildRefreshCoordinator(
  input: RefreshWiringInput,
): SurfaceRefreshCoordinator {
  return new SurfaceRefreshCoordinator(buildRefreshCoordinatorDeps(input))
}

/**
 * What an OWNER session is told to do (KTD11's "an available owner receives
 * serialized work directly").
 *
 * The owner is a live agent mid-conversation, so this carries the same standing
 * guardrail every other Slate injection does: an injected note is a note, not a
 * command to drop in-flight work. The recipe is embedded here rather than put in a
 * brief file because an owner delivery goes through `sendPrompt`, which already
 * treats its argument as data — a background WORKER is the case that needed the
 * file, because its recipe would otherwise be interpolated into a shell command
 * line (see `refreshBriefText`).
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
