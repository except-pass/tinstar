// The Slate's surface author — the one-shot COMPOSE fast path.
//
// COMPOSE ONLY (plan U1, KTD3). This file used to hold a second entry point,
// `launchRefreshWorker`, which gave every automatic refresh a real managed
// background session with its own tmux pane and ttyd port. That is exactly the
// failure mode the trusted-atomic-refresh plan exists to end — 110 of 121 measured
// refreshes changed nothing, and one session accumulated 43 panes — so it is gone,
// along with the port window and worker cap that governed it. Refresh now runs
// either as a machine-only host recipe (no process at all) or through a foreground
// agent the human is already talking to.
//
// `dispatchSurfaceAuthor` REMAINS for COMPOSE, deliberately, and only for it.
// Compose creates a Surface that does not exist yet, at a human's explicit request:
// there is no record to hold an attempt, no generation to compare, and nothing for a
// barrier to supersede. It is not a refresh path and must never be reached from one.
//
// THE COMPOSE FAST PATH. A compose request spawns a fresh, headless `claude -p` child
// in the run's workdir that authors a NEW .tinstar/slate/<slug>.json. The SlateWatcher
// then projects it like any other write. The run's main agent is never involved — that
// is the point of the path.
//
// Deliberately ISOLATED and KILL-SWITCHABLE (one file behind one seam):
//   - The compose route calls the single seam `dispatchSurfaceAuthor`.
//   - `slate.author.enabled: false` disables it entirely — the caller falls back to the
//     main-agent `deliverSlatePrompt` — with no code revert.
//   - Fire-and-forget: we do NOT await the child. Completion = the file appears. A wandering
//     child is bounded by a hard timeout.
//
// SECURITY (semi-trusted). Compose carries file-authored text: it is framed with
// `slateComposePromptText`'s standing GUARDRAIL + `oneLine()` sanitization and passed as a
// single argv element to `spawn()` with NO shell, so a planted `$(…)` is data rather than
// syntax. The child is not sandboxed — an instruction planted by an untrusted branch or
// process runs with the run's own permissions, and that remains a documented residual risk.
import { spawn } from 'node:child_process'
import { getSession } from './session'
import { guestEnv } from './guestEnv'
import { log } from '../logger'

/** The `slate.author` config slice (see TinstarConfig in config.ts). */
export interface SlateAuthorConfig {
  enabled: boolean
  model: string
  timeoutMs: number
}

/**
 * The A2UI authoring contract, prepended to EVERY author prompt. A code-spawned author is
 * a fresh `claude -p` in the run's workdir — which is often a FOREIGN repo with no Tinstar
 * skill and no idea what a Slate surface or A2UI is. Without this it writes nothing valid,
 * and the watcher silently drops it (no surface appears). This is the condensed contract
 * from docs/solutions/documentation-gaps/slate-surface-authoring-contract.md, inlined
 * because the author can't read the docs.
 */
export const SLATE_AUTHOR_CONTRACT = [
  'SLATE SURFACE AUTHORING CONTRACT (you are a one-shot author with no prior context — read this):',
  'Write a Slate "surface" as a JSON file at .tinstar/slate/<slug>.json in the current working directory. File shape:',
  '{ "id": "<stable-slug>", "headline": "<one line>", "author": "agent",',
  '  "anchor": { "kind": "surface" },   // include for a standalone card; OMIT the anchor for an open-point row',
  '  "content": { "root": "<component-id>", "components": [ ... ] },   // A2UI, see below',
  '  "group": "<optional set-id>",   // OPEN-POINT entries only (ignored on an anchored card): give the SAME group',
  '                                  // to a set of related QUESTIONS (2+) and they render side-by-side as a',
  '                                  // workbench, one question per column, each answered on its own. Omit it for a',
  '                                  // normal row. One question per entry — never bundle several questions into one',
  '                                  // entry, or they share a single answer box.',
  '  "refresh": "<optional self-contained instruction to regenerate this FROM SOURCE — never say \'this session\'>",',
  '  "refreshPolicy": {   // OPTIONAL (plan U6). Absent = the host decides: a surface WITH a recipe is',
  '                       // refreshed automatically when its worktree moves; one without is only badged.',
  '    "policy": "automatic" | "mark-stale" | "manual",   // automatic rebuilds it; mark-stale only badges it;',
  '                                                        // manual does neither until a human asks',
  '    "triggers": ["git-revision", "periodic", "source-content", "process-exit",',
  '                 "session-lifecycle", "human-intent", "semantic-signal"],  // CLOSED list; anything else is dropped',
  '    "intervalMs": 1800000,          // for "periodic" — floor is 60000',
  '    "sources": ["file:budget.csv"], // for "source-content" — sources this surface DERIVES FROM',
  '    "signals": ["deploy-finished"]  // for "semantic-signal" — named signals it listens for',
  '  } }',
  '',
  'A2UI `content` is a FLAT list of components referenced BY ID from one `root`. This is the COMPLETE set — nothing else renders:',
  '- Text:    { id, component:"Text", text, variant? }   variant one of: h1 h2 h3 h4 h5 | caption | body',
  '- Column:  { id, component:"Column", children:[ids] }   (vertical stack)',
  '- Row:     { id, component:"Row", children:[ids] }   (horizontal)',
  '- List:    { id, component:"List", children:[ids], listStyle?:"ordered" }',
  '- Card:    { id, component:"Card", child:"<id>" }   (single child, bordered)',
  '- Divider: { id, component:"Divider" }',
  '- Link:    { id, component:"Link", text, url }   (http(s) or /-relative urls only)',
  '- Code:    { id, component:"Code", text }   (monospace block)',
  '- Mermaid: { id, component:"Mermaid", source, theme? }   (a Mermaid definition string, drawn as a diagram)',
  '           e.g. source: "graph TD\\n  A --> B\\n  B -->|yes| C\\n  B -->|no| D"',
  '           Use this for any flow/pipeline/state/sequence picture — do NOT draw one as ASCII art in a Code block.',
  '           theme: "ink" (default, neutral monochrome — prefer it) or "hue" (semantic colors; use only when a',
  '           complex flow needs color to stay legible). Anything else falls back to "ink".',
  '           The diagram is scaled to fit the narrow column and the reader clicks it to expand, so a big',
  '           diagram is fine — but keep labels short, since they shrink with it.',
  '           The host owns theming and sizing: `%%{init: ...}%%` directives and YAML front matter are STRIPPED',
  '           from source. Pick the look with `theme`, not with mermaid config.',
  '- Stepper: { id, component:"Stepper", steps:[ { label, status, detail? }, ... ] }   (a status-colored progress rail)',
  '           status is one of: "pending" | "active" | "done" | "skipped"  (anything else is treated as "pending")',
  '           e.g. steps: [ {"label":"Plan","status":"done"}, {"label":"Build","status":"active","detail":"unit 2/4"},',
  '                         {"label":"Ship","status":"pending"} ]',
  '           Use it for phases/checklists/pipeline progress instead of writing "[x] / [ ]" in a Text or List — it is',
  '           the ONLY way to color a step by state (done=green, active=live cyan, skipped=dimmed). Keep labels short;',
  '           put the running commentary in `detail` on the one active step. A step with no `label` is dropped, and',
  '           only the first 60 VALID steps are drawn (the rest collapse into a "+N more entries not shown" row).',
  'ASKING THE READER SOMETHING — ONLY on an OPEN-POINT entry (one with NO "anchor"), and only when that entry',
  'IS a question. On a standalone card ("anchor": { "kind": "surface" }) these three render PERMANENTLY DISABLED',
  '— a card is shown, not answered — so putting them there gives the reader dead controls. Otherwise omit them:',
  '- Choice:    { id, component:"Choice", mode:"single"|"multi", options:[ { id, label }, ... ] }',
  '- TextInput: { id, component:"TextInput", label?, placeholder? }   (one free-text box per surface)',
  '- Submit:    { id, component:"Submit", label? }   (sends THIS surface\'s answer back to the agent)',
  '           A surface has ONE answer: one text box, one Submit. Several questions = several FILE ENTRIES',
  '           sharing a "group" (see above), never several Submits in one entry.',
  '- Decision: { id, component:"Decision", options:[ { id, label, gain, cost, wrongIf }, ... ] }   (2+ options',
  '           required, one card per open decision). options[].gain/cost/wrongIf are short plain-text lines: what',
  '           you get, what you give up, and the condition that would flip the call.',
  '           risks?:[ { label, severity, likelihood, discoverability, note? }, ... ]   severity: annoying|costly|',
  '           severe, likelihood: unlikely|possible|likely, discoverability: obvious|subtle|silent — all three run',
  '           FINE -> ALARMING, so "silent" means nothing would alert you, not that it is fine.',
  '           reversal?: { action, damage, note? }   action (trivial|cheap|costly|one-way) is how long to undo the',
  '           ACTION; damage (minutes|hours|days|weeks+) is how long to undo the DAMAGE it already did — often a',
  '           very different number from action.',
  '           horizon?: { span, until }   span: until-next-commit|until-this-ships|while-the-code-lives|permanent.',
  '           `until` is REQUIRED whenever span is set — what ends it, phrased to complete "this matters until…".',
  '           comment?: { label?, placeholder? }   customizes the comment box the card ALWAYS renders at its foot',
  '           (label defaults to "Anything else?" when omitted). You may customize it; you may not remove it.',
  '           Needs a Submit sibling, same as Choice. Do NOT also add a TextInput: Decision renders its own',
  '           comment box and already owns the surface\'s one text field — a sibling TextInput just writes the',
  '           same field a second time.',
  'RULES: every id in a children[]/child MUST exist in components; `root` MUST name a component id. There is NO image',
  'or markdown component — use Text/List/Code (Mermaid for diagrams, Stepper for progress). INVALID content is',
  'SILENTLY DROPPED (no surface appears), so keep it minimal and valid. Write ONLY the file; output nothing else.',
].join('\n')

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
  /**
   * Credentials to hand the child EXPLICITLY (`loadSecrets(cfg.dirs.secrets)`),
   * exactly as createTmuxSession injects them into a managed session.
   *
   * This child is a guest boundary, so it gets a scoped env — and unlike an
   * agent pane there is NO login shell to re-export anything. Relying on
   * inheritance would mean hoping the ambient environment happens to carry a
   * credential; if it did not, `claude` would fail to authenticate and, because
   * this dispatch is fire-and-forget, that failure is indistinguishable from
   * the author simply writing nothing. Pass what the child needs.
   */
  secrets?: Record<string, string>
}): { dispatched: boolean } {
  const { sessionsDir, config, runId, prompt, label, secrets } = params
  if (!config.enabled) return { dispatched: false }

  // The author writes into the same dir the SlateWatcher watches: <workdir>/.tinstar/slate/.
  const workdir = getSession(sessionsDir, runId)?.workspace?.path
  if (!workdir) return { dispatched: false }

  try {
    // Headless, one-shot: no tmux, no ttyd, no session record, no Run tile. The prompt is a
    // single argv arg (spawn WITHOUT a shell) so recipe contents can't inject shell syntax.
    // NOTE (spike): the exact `claude -p` invocation may need tuning at first live run —
    // this is the deliberately-throwaway edge.
    // Prepend the authoring contract so a fresh author (often in a foreign repo) knows the
    // A2UI vocabulary + file format. The caller's prompt (recipe/compose) follows it.
    const authorPrompt = SLATE_AUTHOR_CONTRACT + '\n\n' + prompt
    const child = spawn(
      'claude',
      ['-p', authorPrompt, '--model', config.model, '--dangerously-skip-permissions'],
      // Guest boundary: this claude runs IN the run's workdir (someone else's
      // repo) and can run that repo's tooling, so it must not inherit Tinstar's
      // runtime config — same NODE_ENV trap as an agent pane. See ./guestEnv.ts.
      // Credentials are INJECTED, not inherited (see `secrets` above).
      { cwd: workdir, stdio: 'ignore', detached: false, timeout: config.timeoutMs, env: guestEnv(secrets ?? {}) },
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
