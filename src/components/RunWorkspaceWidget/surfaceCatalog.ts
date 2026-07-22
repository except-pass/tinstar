// The Slate surface catalog (plan U4/U5) — a typed registry of reusable surface
// templates the "+ Add surface" composer fuzzy-searches, so the user picks a starting
// point instead of describing a surface from scratch each time.
//
// A template is just an authoring PROMPT the run's agent receives (POST /slate/compose);
// the agent writes the actual `.tinstar/slate/<slug>.json`. The catalog is client-side
// and additive — a new template is one entry here.

export interface SurfaceTemplate {
  /** Stable id / slug (also the suggested .tinstar/slate/<id>.json filename). */
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
      'so refreshing regenerates column B. Write it to .tinstar/slate/pr-review.json ' +
      '(id, headline, A2UI content with two columns, refresh recipe).',
  },
  {
    id: 'dataflow',
    name: 'Dataflow',
    description: 'A diagram of the external resources this run touches and the reads/writes between them.',
    prompt:
      'Author a "Dataflow" surface: a diagram of the external resources this run touches ' +
      '(files, APIs, services, databases) and the directional reads/writes/mutations between ' +
      'them — nodes plus directed edges, with read/edit/create badges. ' +
      'Set a `refresh` recipe of "re-derive this run’s dataflow and rewrite this surface". ' +
      'Write it to .tinstar/slate/dataflow.json (id, headline, A2UI content, refresh recipe).',
  },
  {
    id: 'open-points',
    name: 'Open points',
    description: 'The run’s current open questions and decisions as a threaded checklist.',
    prompt:
      'Author the run’s current OPEN POINTS: each unresolved question or decision as a ' +
      'point (a short headline, optional body). Write each as a JSON entry under ' +
      '.tinstar/slate/ (id, headline, optional content). These render in the open-points list.',
  },
  {
    id: 'checklist',
    name: 'Checklist',
    description: 'The remaining steps for the current task as an A2UI checklist.',
    prompt:
      'Author a "Checklist" surface: the remaining steps for the current task as an A2UI list ' +
      'of items. Set a `refresh` recipe of "re-derive the remaining checklist from the current ' +
      'plan/state and rewrite this surface". Write it to .tinstar/slate/checklist.json ' +
      '(id, headline, A2UI content, refresh recipe).',
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
  return matched === q.length ? 10 + bestRun : 0
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
