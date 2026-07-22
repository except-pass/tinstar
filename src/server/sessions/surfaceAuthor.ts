// The Slate's one-shot surface author (feat: multi-agent Slate — the whole spike lives here).
//
// When a surface carries a self-contained `refresh` recipe (source-derived), refreshing it
// spawns a fresh, headless `claude -p` child in the run's workdir that executes the recipe and
// writes the .tinstar/slate/<slug>.json file. The SlateWatcher then projects it like any other
// write. The run's main agent is NEVER involved — that's the whole point.
//
// Deliberately ISOLATED and KILL-SWITCHABLE (the feature is one file behind one seam):
//   - The refresh/compose route calls the single seam `dispatchSurfaceAuthor`.
//   - `slate.author.enabled: false` disables the path entirely — the caller falls back to the
//     main-agent `deliverSlatePrompt` — with no code revert.
//   - Fire-and-forget: we do NOT await the child. Completion = the file appears (the watcher
//     projects it; `amendedAt` advances; the client's bounded refresh spinner clears). A
//     wandering/hung author is bounded by a hard timeout and stays VISIBLE to the client via
//     that spinner timing out — no new server-owned state (KTD4).
//
// SECURITY (KTD6, semi-trusted): the recipe is file-authored, so the delivered prompt is framed
// by `slateRefreshPromptText`'s standing GUARDRAIL + `oneLine()` sanitization. The child runs
// with the run's own permissions; a recipe planted by an untrusted branch/process is a
// documented residual risk, not sandboxed here.
import { spawn } from 'node:child_process'
import { getSession } from './session'
import { log } from '../logger'

/** The `slate.author` config slice (see TinstarConfig in config.ts). */
export interface SlateAuthorConfig {
  enabled: boolean
  model: string
  timeoutMs: number
}

/**
 * Spawn a one-shot author with a PRE-BUILT prompt. The caller's prompt builder
 * (`slateRefreshPromptText` for refresh, `slateComposePromptText` for compose) is
 * responsible for the standing GUARDRAIL + `oneLine()` sanitization — the author just
 * launches the child. Returns `{ dispatched }`:
 *   - `true`  — a child was launched. The caller returns `dispatched:true` immediately; the
 *               surface arrives later via the watcher. The main agent is not touched.
 *   - `false` — disabled, no workdir, or the spawn failed → the caller falls back to the
 *               main-agent path (`deliverSlatePrompt`). NEVER throws into the request path.
 * `label` is used only for logging (e.g. the surface id, or "compose").
 */
export function dispatchSurfaceAuthor(params: {
  sessionsDir: string
  config: SlateAuthorConfig
  runId: string
  prompt: string
  label: string
}): { dispatched: boolean } {
  const { sessionsDir, config, runId, prompt, label } = params
  if (!config.enabled) return { dispatched: false }

  // The author writes into the same dir the SlateWatcher watches: <workdir>/.tinstar/slate/.
  const workdir = getSession(sessionsDir, runId)?.workspace?.path
  if (!workdir) return { dispatched: false }

  try {
    // Headless, one-shot: no tmux, no ttyd, no session record, no Run tile. The prompt is a
    // single argv arg (spawn WITHOUT a shell) so recipe contents can't inject shell syntax.
    // NOTE (spike): the exact `claude -p` invocation may need tuning at first live run —
    // this is the deliberately-throwaway edge.
    const child = spawn(
      'claude',
      ['-p', prompt, '--model', config.model, '--dangerously-skip-permissions'],
      { cwd: workdir, stdio: 'ignore', detached: false, timeout: config.timeoutMs },
    )
    child.on('error', (err) =>
      log.warn('slate-author', 'spawn failed', { runId, label, err: err.message }))
    child.on('exit', (code, signal) =>
      log.info('slate-author', 'author exited', { runId, label, code, signal }))
    // Don't keep the server's event loop alive waiting on the child (fire-and-forget).
    child.unref()
    return { dispatched: true }
  } catch (err) {
    log.warn('slate-author', 'dispatch error', { runId, label, err: (err as Error).message })
    return { dispatched: false }
  }
}
