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
  '  "refresh": "<optional self-contained instruction to regenerate this FROM SOURCE — never say \'this session\'>" }',
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
  '- Stepper: { id, component:"Stepper", steps:[ { label, status, detail? }, ... ] }   (a status-colored progress rail)',
  '           status is one of: "pending" | "active" | "done" | "skipped"  (anything else is treated as "pending")',
  '           e.g. steps: [ {"label":"Plan","status":"done"}, {"label":"Build","status":"active","detail":"unit 2/4"},',
  '                         {"label":"Ship","status":"pending"} ]',
  '           Use it for phases/checklists/pipeline progress instead of writing "[x] / [ ]" in a Text or List — it is',
  '           the ONLY way to color a step by state (done=green, active=live cyan, skipped=dimmed). Keep labels short;',
  '           put the running commentary in `detail` on the one active step. A step with no `label` is dropped, and',
  '           only the first 60 steps are drawn (the rest collapse into a "+N more not shown" row).',
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
    // Prepend the authoring contract so a fresh author (often in a foreign repo) knows the
    // A2UI vocabulary + file format. The caller's prompt (recipe/compose) follows it.
    const authorPrompt = SLATE_AUTHOR_CONTRACT + '\n\n' + prompt
    const child = spawn(
      'claude',
      ['-p', authorPrompt, '--model', config.model, '--dangerously-skip-permissions'],
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
