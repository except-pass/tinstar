// The Slate's shared surface catalog — used by both the composer and the server.
// templates the "+ Add surface" composer fuzzy-searches, so the user picks a starting
// point instead of describing a surface from scratch each time.
//
// A template is an authoring prompt plus its saved human label. Keeping this module
// React-free lets the server resolve a stable template id instead of trusting a full
// prompt copied back from the browser.

export interface SurfaceTemplate {
  /** Stable catalog id. The host assigns the saved card and source filename. */
  id: string
  /** Human name shown in the composer and fuzzy-matched. */
  name: string
  /** One-line description, shown under the name and fuzzy-matched (weighted lower). */
  description: string
  /** The authoring prompt delivered to the run's agent. */
  prompt: string
}

/** Seed catalog. Order here is the default (empty-query) order. */
export const SURFACE_CATALOG: SurfaceTemplate[] = [
  {
    id: 'pr-review',
    name: 'PR review',
    description: 'Two columns: the PR’s intent vs a blind read of what the diff actually does.',
    prompt:
      'Author a two-column "PR review" surface for the pull request under discussion. ' +
      'Column A: the PR’s STATED INTENT, taken from its title / body / linked plan. ' +
      'Column B: dispatch a BLIND subagent given ONLY the diff (no intent, no PR description) ' +
      'and render its plain description of what the code actually does. The value is the GAP ' +
      'between the two columns — do not reconcile them. ' +
      'Set a `refresh` recipe of "re-run the blind eval of this PR and rewrite this surface", ' +
      'so refreshing regenerates column B.',
  },
  {
    id: 'dataflow',
    name: 'Dataflow',
    description: 'A diagram of the external resources this run touches and the reads/writes between them.',
    prompt:
      'Author a "Dataflow" surface: a diagram of the external resources this run touches ' +
      '(files, APIs, services, databases) and the directional reads/writes/mutations between ' +
      'them — nodes plus directed edges, with read/edit/create badges. ' +
      'Set a `refresh` recipe of "re-derive this run’s dataflow and rewrite this surface".',
  },
  {
    id: 'open-points',
    name: 'Open points',
    description: 'The run’s current open questions and decisions as a threaded checklist.',
    prompt:
      'Author one "Open points" card containing the run’s current unresolved questions ' +
      'and decisions as a concise A2UI list. If there are none, the visible headline or ' +
      'body must say exactly "No open points". Produce exactly the one assigned entry.',
  },
  {
    id: 'checklist',
    name: 'Checklist',
    description: 'The remaining steps for the current task as an A2UI checklist.',
    prompt:
      'Author a "Checklist" surface: the remaining steps for the current task as an A2UI list ' +
      'of items. Set a `refresh` recipe of "re-derive the remaining checklist from the current ' +
      'plan/state and rewrite this surface".',
  },
  {
    id: 'decision',
    name: 'Decision',
    description: 'One open decision: options with their tradeoffs, risks, cost to undo, and how long it matters.',
    prompt:
      'Author a "Decision" surface for the open decision under discussion, using the ' +
      '`Decision` A2UI component plus a `Submit` sibling. Give it at least two options, ' +
      'each `{ id, label, gain, cost, wrongIf }` — `cost` must name a CONCRETE loss ' +
      '("adds complexity" does not count) and `wrongIf` is the condition that would flip ' +
      'the call. Add `risks: [{ label, severity, likelihood, discoverability, note }]` — ' +
      'severity is annoying|costly|severe, likelihood is unlikely|possible|likely, ' +
      'discoverability is obvious|subtle|silent. All three run fine → alarming, so ' +
      '"silent" means nothing would alert us. Add ' +
      '`reversal: { action, damage, note }` — action is trivial|cheap|costly|one-way ' +
      '(how long to undo the ACTION) and damage is minutes|hours|days|weeks+ (how long ' +
      'to undo the DAMAGE); they are frequently different numbers. Add ' +
      '`horizon: { span, until }` — span is until-next-commit|until-this-ships|' +
      'while-the-code-lives|permanent, and `until` completes "this matters until…". ' +
      'Use permanent when something survives an undo: rows written, mail sent, an API ' +
      'published, a person who already saw it. The card always renders a comment box at ' +
      'its foot (default label "Anything else?"); optionally set `comment: { label, ' +
      'placeholder }` to customize it, but do NOT add a TextInput — the Decision card ' +
      'already owns the surface\'s one text field. Do not set a `refresh` recipe: refreshing would ' +
      're-derive the very question the user is mid-answer on and rewrite it under them.',
  },
]

/** Score how well `query` matches `target`. 0 = no match. Higher = better.
 *  Substring match scores high (prefix bonus); otherwise a subsequence match scores
 *  low, rewarding a longer contiguous run. No dependency — a small hand-rolled scorer. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase()
  if (!q) return 1
  const at = t.indexOf(q)
  if (at !== -1) return 100 + (at === 0 ? 50 : 0)
  // subsequence
  let ti = 0
  let matched = 0
  let run = 0
  let bestRun = 0
  for (const ch of q) {
    const idx = t.indexOf(ch, ti)
    if (idx === -1) return 0
    run = idx === ti ? run + 1 : 1
    bestRun = Math.max(bestRun, run)
    matched += 1
    ti = idx + 1
  }
  // Every char found (any miss already returned 0 above) → a subsequence match. Don't
  // gate on matched === q.length: `for…of` counts code points while `q.length` counts
  // UTF-16 units, so an astral-plane query (emoji) would wrongly score 0.
  return 10 + bestRun
}

/** Fuzzy-search the catalog by name (full weight) + description (half weight).
 *  Empty query returns the whole catalog in its declared order. */
export function searchSurfaceCatalog(query: string): SurfaceTemplate[] {
  const q = query.trim()
  if (!q) return [...SURFACE_CATALOG]
  return SURFACE_CATALOG
    .map((t) => ({ t, s: Math.max(fuzzyScore(q, t.name), fuzzyScore(q, t.description) * 0.5) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t)
}
