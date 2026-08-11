# Decision card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Decision` A2UI control primitive that presents one open decision on a run's Slate — its options with gain/cost/wrong-if, its risks scored on three same-direction scales, its cost to undo, and how long it keeps mattering — and lets the user pick one option plus leave a comment.

**Architecture:** `Decision` is a *control* component, not a display block, so its options are the single declaration feeding both the rendered radios and the server's answer validation. Parsing lives in `src/a2ui/controls.ts` (React-free — the server bundles it for `POST …/points/:pid/answer` validation at `src/server/api/routes.ts:4938`); rendering lives in `src/a2ui/controlComponents.tsx` and registers in `src/a2ui/catalog.tsx`. This is exactly the split `Choice` already uses. No server, schema, or endpoint change is needed: A2UI's `AnyComponentSchema` is passthrough, and the answer form already carries `{ choices?, text? }`.

**Tech Stack:** TypeScript, React 18, Tailwind (custom palette in `tailwind.theme.js`), Vitest + @testing-library/react, jsdom.

**Source spec:** `docs/brainstorms/2026-08-06-decision-card-requirements.md`

## Global Constraints

- **`src/a2ui/controls.ts` must stay React-free and browser-global-free.** It is imported by the server bundle (esbuild) as well as the client bundle. No JSX, no `document`, no `window` in that file.
- **Tailwind class strings must be literal, never interpolated fragments.** The JIT only emits classes it can see as whole strings, and `eslint-rules/valid-theme-classnames.js` lints them against `tailwind.theme.js`. Follow the `STEP_NODE` pattern in `catalog.tsx:194` — a `Record` of complete class strings.
- **Only palette tokens from `tailwind.theme.js` exist.** For this feature: `hue-discussing` (#ffc266 amber), `ink-low`, `ink-mid`, `ink-high`, `surface-hover`, `hairline`. `hue-error` is reserved for failed actions and must NOT be used here.
- **Prose must pin `font-sans` explicitly.** The run card defaults to mono, so any authored reading text (`gain`, `cost`, `wrongIf`, `note`, `until`) without `font-sans` renders as terminal output. Labels and rating chips stay mono by design.
- **Prefix npm/vitest/tsc with `env -u NODE_ENV`.** A `NODE_ENV=production` shell causes spurious vitest "act not supported" failures.
- **Typecheck means `npm run typecheck` (three tsconfigs), not `tsc -p tsconfig.app.json`.** The app-only config skips test files, so a broken test import passes locally and fails CI.
- **Scale values, verbatim from the spec:**
  - `severity`: `annoying` | `costly` | `severe`
  - `likelihood`: `unlikely` | `possible` | `likely`
  - `discoverability`: `obvious` | `subtle` | `silent`
  - `reversal.action`: `trivial` | `cheap` | `costly` | `one-way`
  - `reversal.damage`: `minutes` | `hours` | `days` | `weeks+`
  - `horizon.span`: `until-next-commit` | `until-this-ships` | `while-the-code-lives` | `permanent`
- **Every scale runs fine → alarming, left to right.** The last value of each scale is the dangerous end.
- **The host never coerces an unrecognized rating.** Unknown word → render it verbatim, uncolored. Never map it to a known value in either direction.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/a2ui/controls.ts` (modify) | `Decision` type constant, the six scales, `rate()`, `parseDecision()`, membership in `CONTROL_COMPONENTS`, contribution to the two option collectors. React-free. | 1 |
| `src/a2ui/__tests__/controls.test.ts` (modify) | Parse + collector + answerability tests. | 1 |
| `src/a2ui/controlComponents.tsx` (modify) | `DecisionControl` — the rendered card and its rating chips. | 2, 3 |
| `src/a2ui/catalog.tsx` (modify) | Register `Decision` with a `cost` hook. | 2 |
| `src/a2ui/__tests__/DecisionControl.test.tsx` (create) | Render, interaction, degradation tests. | 2, 3 |
| `src/components/RunWorkspaceWidget/surfaceCatalog.ts` (modify) | A `decision` composer template. | 4 |
| `src/components/RunWorkspaceWidget/__tests__/surfaceCatalog.test.ts` (modify or create) | Template is findable by fuzzy search. | 4 |
| `docs/the-slate.md`, `docs/slate-design-language.md`, `agent-skills/skills/slate-surface/SKILL.md` (modify) | Vocabulary + authoring rules. | 4 |

---

### Task 1: Parse and control registration (`controls.ts`)

**Files:**
- Modify: `src/a2ui/controls.ts`
- Test: `src/a2ui/__tests__/controls.test.ts`

**Interfaces:**
- Consumes: `A2uiComponent`, `A2uiContent` from `../domain/types`; the existing `parseChoice`, `CONTROL_COMPONENTS`, `collectChoiceOptionIds`, `collectChoiceOptionLabels`, `isAnswerable`.
- Produces, for Tasks 2–3:
  - `DECISION_COMPONENT: 'Decision'`
  - `interface Rating { value: string; heat: number | null }`
  - `interface DecisionOption { id: string; label: string; gain: string; cost: string; wrongIf: string }`
  - `interface DecisionRisk { label: string; severity: Rating | null; likelihood: Rating | null; discoverability: Rating | null; note: string }`
  - `interface DecisionReversal { action: Rating | null; damage: Rating | null; note: string }`
  - `interface DecisionHorizon { span: Rating | null; until: string }`
  - `interface ParsedDecision { options: DecisionOption[]; risks: DecisionRisk[]; risksMalformed: boolean; reversal: DecisionReversal | null; reversalMalformed: boolean; horizon: DecisionHorizon | null; horizonMalformed: boolean; comment: { label: string; placeholder: string } }`
  - `parseDecision(node: A2uiComponent): ParsedDecision | null`
  - `MAX_DECISION_OPTIONS = 8`, `MAX_DECISION_RISKS = 12`

**Design notes the implementer needs:**

`heat` is an ordinal 0–3 intensity, not a color — the render layer maps it to classes. A 3-value scale stretches onto the 4-step ramp as `0, 2, 3` so its top step is as hot as a 4-value scale's top step; a 4-value scale maps straight through. `heat: null` means *the host did not recognize this word* — render it verbatim and uncolored (spec R8).

`Rating | null` distinguishes **absent** (`null` — draw nothing) from **unrecognized** (`{ value: 'catastrophic', heat: null }` — draw the word, no color).

- [ ] **Step 1: Write the failing tests**

Append to `src/a2ui/__tests__/controls.test.ts`. Add `parseDecision`, `DECISION_COMPONENT`, `MAX_DECISION_OPTIONS`, `MAX_DECISION_RISKS` to the existing import block from `'../controls'`.

```ts
// ---------------------------------------------------------------------------
// Decision (the Decision card, docs/brainstorms/2026-08-06-decision-card-requirements.md)
// ---------------------------------------------------------------------------

/** A minimal well-formed Decision node — two options is the floor (R9). */
function decisionNode(overrides: Record<string, unknown> = {}) {
  return {
    component: 'Decision',
    id: 'd',
    options: [
      { id: 'worktree', label: 'Isolated worktree', gain: 'No stomping.', cost: '~400ms each.', wrongIf: 'Hands mostly read.' },
      { id: 'locks', label: 'Advisory locks', gain: 'Zero setup.', cost: 'Stale locks.', wrongIf: 'Two hands write one file.' },
    ],
    ...overrides,
  }
}

describe('parseDecision', () => {
  it('parses options into id/label/gain/cost/wrongIf', () => {
    const d = parseDecision(decisionNode())!
    expect(d.options).toHaveLength(2)
    expect(d.options[0]).toEqual({
      id: 'worktree', label: 'Isolated worktree',
      gain: 'No stomping.', cost: '~400ms each.', wrongIf: 'Hands mostly read.',
    })
  })

  it('returns null for a non-Decision node', () => {
    expect(parseDecision({ component: 'Choice', options: [{ id: 'a', label: 'A' }] })).toBeNull()
  })

  it('degrades whole (null) below two usable options — one option is not a decision', () => {
    expect(parseDecision({ component: 'Decision' })).toBeNull()
    expect(parseDecision({ component: 'Decision', options: [] })).toBeNull()
    expect(parseDecision({ component: 'Decision', options: [{ id: 'a', label: 'A' }] })).toBeNull()
    // Two entries but one has no usable id → one survivor → still not a decision.
    expect(parseDecision({ component: 'Decision', options: [{ id: 'a', label: 'A' }, { label: 'no id' }] })).toBeNull()
  })

  it('defaults missing option prose to empty strings rather than dropping the option', () => {
    const d = parseDecision({ component: 'Decision', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })!
    expect(d.options[0]).toEqual({ id: 'a', label: 'A', gain: '', cost: '', wrongIf: '' })
  })

  it('caps options at MAX_DECISION_OPTIONS', () => {
    const many = Array.from({ length: MAX_DECISION_OPTIONS + 5 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }))
    expect(parseDecision({ component: 'Decision', options: many })!.options).toHaveLength(MAX_DECISION_OPTIONS)
  })

  it('rates a three-value scale onto the 0/2/3 ramp so its top step is fully hot', () => {
    const d = parseDecision(decisionNode({
      risks: [
        { label: 'r0', severity: 'annoying', likelihood: 'unlikely', discoverability: 'obvious' },
        { label: 'r1', severity: 'costly', likelihood: 'possible', discoverability: 'subtle' },
        { label: 'r2', severity: 'severe', likelihood: 'likely', discoverability: 'silent' },
      ],
    }))!
    expect(d.risks.map(r => r.severity!.heat)).toEqual([0, 2, 3])
    expect(d.risks.map(r => r.likelihood!.heat)).toEqual([0, 2, 3])
    expect(d.risks.map(r => r.discoverability!.heat)).toEqual([0, 2, 3])
  })

  it('rates a four-value scale straight through 0..3', () => {
    const actions = ['trivial', 'cheap', 'costly', 'one-way']
    const heats = actions.map(a => parseDecision(decisionNode({ reversal: { action: a, damage: 'days' } }))!.reversal!.action!.heat)
    expect(heats).toEqual([0, 1, 2, 3])
    const damages = ['minutes', 'hours', 'days', 'weeks+']
    const dh = damages.map(x => parseDecision(decisionNode({ reversal: { action: 'cheap', damage: x } }))!.reversal!.damage!.heat)
    expect(dh).toEqual([0, 1, 2, 3])
    const spans = ['until-next-commit', 'until-this-ships', 'while-the-code-lives', 'permanent']
    const sh = spans.map(s => parseDecision(decisionNode({ horizon: { span: s, until: 'x' } }))!.horizon!.span!.heat)
    expect(sh).toEqual([0, 1, 2, 3])
  })

  it('keeps an unrecognised rating verbatim with heat null — never coerced up or down (R8)', () => {
    const d = parseDecision(decisionNode({ risks: [{ label: 'r', severity: 'catastrophic' }] }))!
    expect(d.risks[0].severity).toEqual({ value: 'catastrophic', heat: null })
  })

  it('distinguishes an absent rating (null) from an unrecognised one', () => {
    const d = parseDecision(decisionNode({ risks: [{ label: 'r', severity: 'severe' }] }))!
    expect(d.risks[0].severity).toEqual({ value: 'severe', heat: 3 })
    expect(d.risks[0].likelihood).toBeNull()
    expect(d.risks[0].discoverability).toBeNull()
  })

  it('drops risks with no label and flags risksMalformed only when nothing survives', () => {
    const some = parseDecision(decisionNode({ risks: [{ label: 'keep' }, { note: 'no label' }] }))!
    expect(some.risks).toHaveLength(1)
    expect(some.risksMalformed).toBe(false)
    const none = parseDecision(decisionNode({ risks: 'not an array' }))!
    expect(none.risks).toEqual([])
    expect(none.risksMalformed).toBe(true)
  })

  it('does not flag risksMalformed when risks is simply absent', () => {
    expect(parseDecision(decisionNode()).risksMalformed).toBe(false)
  })

  it('caps risks at MAX_DECISION_RISKS', () => {
    const many = Array.from({ length: MAX_DECISION_RISKS + 5 }, (_, i) => ({ label: `r${i}` }))
    expect(parseDecision(decisionNode({ risks: many }))!.risks).toHaveLength(MAX_DECISION_RISKS)
  })

  it('requires `until` whenever a horizon span is present (R4)', () => {
    const ok = parseDecision(decisionNode({ horizon: { span: 'permanent', until: 'the migration wrote rows' } }))!
    expect(ok.horizon).toEqual({ span: { value: 'permanent', heat: 3 }, until: 'the migration wrote rows' })
    expect(ok.horizonMalformed).toBe(false)
    const noUntil = parseDecision(decisionNode({ horizon: { span: 'permanent' } }))!
    expect(noUntil.horizon).toBeNull()
    expect(noUntil.horizonMalformed).toBe(true)
  })

  it('flags reversalMalformed when reversal carries neither rating', () => {
    const bad = parseDecision(decisionNode({ reversal: { note: 'only a note' } }))!
    expect(bad.reversal).toBeNull()
    expect(bad.reversalMalformed).toBe(true)
    const ok = parseDecision(decisionNode({ reversal: { action: 'cheap' } }))!
    expect(ok.reversal).toEqual({ action: { value: 'cheap', heat: 1 }, damage: null, note: '' })
  })

  it('a malformed block never takes the options down with it (R9)', () => {
    const d = parseDecision(decisionNode({ risks: 'garbage', reversal: 42, horizon: null }))!
    expect(d.options).toHaveLength(2)
    expect(d.risksMalformed).toBe(true)
    expect(d.reversalMalformed).toBe(true)
  })

  it('defaults the comment field label and honors an author override (R7)', () => {
    expect(parseDecision(decisionNode()).comment).toEqual({ label: 'Anything else?', placeholder: '' })
    const custom = parseDecision(decisionNode({ comment: { label: 'Constraints?', placeholder: 'e.g. deadline' } }))!
    expect(custom.comment).toEqual({ label: 'Constraints?', placeholder: 'e.g. deadline' })
  })
})

describe('Decision is a control component', () => {
  const content: A2uiContent = { root: 'd', components: [decisionNode()] }

  it('makes a surface answerable (R1)', () => {
    expect(isAnswerable(content)).toBe(true)
  })

  it('contributes its option ids to the endpoint validator (R1)', () => {
    expect(collectChoiceOptionIds(content)).toEqual(new Set(['worktree', 'locks']))
  })

  it('contributes its option labels so a delivered prompt names the choice in words', () => {
    expect(collectChoiceOptionLabels(content).get('worktree')).toBe('Isolated worktree')
  })

  it('a Decision below the two-option floor contributes no ids', () => {
    const thin: A2uiContent = { root: 'd', components: [{ component: 'Decision', id: 'd', options: [{ id: 'a', label: 'A' }] }] }
    expect(collectChoiceOptionIds(thin).size).toBe(0)
  })

  it('coexists with a Choice without either clobbering the other', () => {
    const both: A2uiContent = {
      root: 'r',
      components: [decisionNode(), { component: 'Choice', id: 'c', options: [{ id: 'yes', label: 'Yes' }] }],
    }
    expect(collectChoiceOptionIds(both)).toEqual(new Set(['worktree', 'locks', 'yes']))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u NODE_ENV npx vitest run src/a2ui/__tests__/controls.test.ts`
Expected: FAIL — `parseDecision is not a function` / import errors for the new names.

- [ ] **Step 3: Implement the parse layer**

In `src/a2ui/controls.ts`, add `DECISION_COMPONENT` beside the existing constants and include it in `CONTROL_COMPONENTS`:

```ts
export const DECISION_COMPONENT = 'Decision'

export const CONTROL_COMPONENTS: ReadonlySet<string> = new Set([
  CHOICE_COMPONENT,
  TEXT_INPUT_COMPONENT,
  SUBMIT_COMPONENT,
  DECISION_COMPONENT,
])
```

Then append the Decision block at the end of the file:

```ts
// ---------------------------------------------------------------------------
// Decision — one open decision, with its tradeoffs, risks, cost to undo, and
// horizon. A CONTROL, not a display block: its options are the single
// declaration feeding both the rendered radios and the server's answer
// validation, so an author cannot let the pick and the reasoning drift apart.
//
// Two corrections to FMEA are baked into the scales below. First, every scale
// runs fine → alarming left to right, including `discoverability` — FMEA's
// "detection" reads as a virtue while its rating runs bad-upward, so a reader
// has to translate every cell. Second, nothing here multiplies into a composite:
// these are ordinal scales, and an RPN-style product of ordinals is arithmetic
// on labels. The reader reads the cells.
// ---------------------------------------------------------------------------

/** Hard caps, for the same reason `Stepper` has MAX_STEPS: one node expands into
 *  many rows, and the renderer's node budget counts components. The catalog's
 *  `cost` hook charges these rows to the per-surface budget. */
export const MAX_DECISION_OPTIONS = 8
export const MAX_DECISION_RISKS = 12

export const SEVERITY_SCALE = ['annoying', 'costly', 'severe'] as const
export const LIKELIHOOD_SCALE = ['unlikely', 'possible', 'likely'] as const
export const DISCOVERABILITY_SCALE = ['obvious', 'subtle', 'silent'] as const
export const REVERSAL_ACTION_SCALE = ['trivial', 'cheap', 'costly', 'one-way'] as const
export const REVERSAL_DAMAGE_SCALE = ['minutes', 'hours', 'days', 'weeks+'] as const
export const HORIZON_SCALE = ['until-next-commit', 'until-this-ships', 'while-the-code-lives', 'permanent'] as const

/** A scored dimension. `heat` is an ordinal 0–3 intensity on a shared ramp — NOT
 *  a color; the render layer owns that mapping. `heat: null` means the host does
 *  not recognise the word: render it verbatim and uncolored, never coerced to a
 *  known value. Coercing down would silently understate a risk and coercing up
 *  would cry wolf, which is why this differs from Stepper's unknown → `pending`
 *  (a neutral default is safe for progress and unsafe for risk). */
export interface Rating {
  value: string
  heat: number | null
}

/** Rate a raw prop against its scale. `null` = absent (draw nothing), which is a
 *  different thing from unrecognised (draw the word, don't color it).
 *  A 3-step scale stretches onto the 4-step ramp as 0/2/3 so its top step is as
 *  hot as a 4-step scale's; a 4-step scale maps straight through. */
function rate(raw: unknown, scale: readonly string[]): Rating | null {
  if (typeof raw !== 'string' || raw === '') return null
  const i = scale.indexOf(raw)
  if (i === -1) return { value: raw, heat: null }
  return { value: raw, heat: scale.length === 3 ? [0, 2, 3][i] : i }
}

/** Read an optional prose prop, coercing anything non-string to ''. */
function prose(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

export interface DecisionOption {
  id: string
  label: string
  /** What you get. */
  gain: string
  /** What you give up — concrete, not "more complexity". */
  cost: string
  /** The condition that would flip the call. */
  wrongIf: string
}

export interface DecisionRisk {
  label: string
  severity: Rating | null
  likelihood: Rating | null
  discoverability: Rating | null
  note: string
}

export interface DecisionReversal {
  /** How long to undo the ACTION. */
  action: Rating | null
  /** How long to undo the DAMAGE — routinely a very different number. */
  damage: Rating | null
  note: string
}

export interface DecisionHorizon {
  span: Rating | null
  /** What ends it, phrased to complete "this matters until…". Required whenever
   *  `span` is present: it is the field that forces the author to say out loud
   *  what survives an undo. */
  until: string
}

export interface ParsedDecision {
  options: DecisionOption[]
  risks: DecisionRisk[]
  /** The author declared risks and none survived → show the inline notice. */
  risksMalformed: boolean
  reversal: DecisionReversal | null
  reversalMalformed: boolean
  horizon: DecisionHorizon | null
  horizonMalformed: boolean
  comment: { label: string; placeholder: string }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function parseOptions(raw: unknown): DecisionOption[] {
  if (!Array.isArray(raw)) return []
  const out: DecisionOption[] = []
  for (const o of raw) {
    if (out.length >= MAX_DECISION_OPTIONS) break
    if (!isRecord(o)) continue
    const { id, label } = o
    if (typeof id !== 'string' || id === '') continue
    if (typeof label !== 'string' || label === '') continue
    out.push({ id, label, gain: prose(o.gain), cost: prose(o.cost), wrongIf: prose(o.wrongIf) })
  }
  return out
}

function parseRisks(raw: unknown): { risks: DecisionRisk[]; malformed: boolean } {
  if (raw === undefined || raw === null) return { risks: [], malformed: false }
  if (!Array.isArray(raw)) return { risks: [], malformed: true }
  const risks: DecisionRisk[] = []
  for (const r of raw) {
    if (risks.length >= MAX_DECISION_RISKS) break
    if (!isRecord(r)) continue
    const label = r.label
    if (typeof label !== 'string' || label === '') continue
    risks.push({
      label,
      severity: rate(r.severity, SEVERITY_SCALE),
      likelihood: rate(r.likelihood, LIKELIHOOD_SCALE),
      discoverability: rate(r.discoverability, DISCOVERABILITY_SCALE),
      note: prose(r.note),
    })
  }
  // An author who declared risks and got none rendered needs to be told; an
  // author who declared none is simply not using the block.
  return { risks, malformed: risks.length === 0 && raw.length > 0 }
}

function parseReversal(raw: unknown): { reversal: DecisionReversal | null; malformed: boolean } {
  if (raw === undefined || raw === null) return { reversal: null, malformed: false }
  if (!isRecord(raw)) return { reversal: null, malformed: true }
  const action = rate(raw.action, REVERSAL_ACTION_SCALE)
  const damage = rate(raw.damage, REVERSAL_DAMAGE_SCALE)
  // A note with no ratings is prose pretending to be a block — the reversal
  // section exists to state two numbers.
  if (!action && !damage) return { reversal: null, malformed: true }
  return { reversal: { action, damage, note: prose(raw.note) }, malformed: false }
}

function parseHorizon(raw: unknown): { horizon: DecisionHorizon | null; malformed: boolean } {
  if (raw === undefined || raw === null) return { horizon: null, malformed: false }
  if (!isRecord(raw)) return { horizon: null, malformed: true }
  const span = rate(raw.span, HORIZON_SCALE)
  const until = prose(raw.until)
  if (!span || until === '') return { horizon: null, malformed: true }
  return { horizon: { span, until }, malformed: false }
}

function parseComment(raw: unknown): { label: string; placeholder: string } {
  const fallback = { label: 'Anything else?', placeholder: '' }
  if (!isRecord(raw)) return fallback
  return {
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : fallback.label,
    placeholder: prose(raw.placeholder),
  }
}

/** Parse a `Decision` node, or `null` when it is not a decision at all — a wrong
 *  component type, or fewer than two usable options (one option is not a
 *  decision). A malformed *block* never returns null: risks, reversal, and
 *  horizon each degrade on their own so a typo in one cannot hide the options. */
export function parseDecision(node: A2uiComponent): ParsedDecision | null {
  if (node.component !== DECISION_COMPONENT) return null
  const options = parseOptions(node.options)
  if (options.length < 2) return null
  const { risks, malformed: risksMalformed } = parseRisks(node.risks)
  const { reversal, malformed: reversalMalformed } = parseReversal(node.reversal)
  const { horizon, malformed: horizonMalformed } = parseHorizon(node.horizon)
  return {
    options,
    risks,
    risksMalformed,
    reversal,
    reversalMalformed,
    horizon,
    horizonMalformed,
    comment: parseComment(node.comment),
  }
}
```

Now teach the two collectors about it. Replace the bodies of `collectChoiceOptionIds` and `collectChoiceOptionLabels` with:

```ts
export function collectChoiceOptionIds(content: A2uiContent | undefined | null): Set<string> {
  const ids = new Set<string>()
  if (!content || !Array.isArray(content.components)) return ids
  for (const node of content.components) {
    const choice = parseChoice(node)
    if (choice) for (const o of choice.options) ids.add(o.id)
    const decision = parseDecision(node)
    if (decision) for (const o of decision.options) ids.add(o.id)
  }
  return ids
}

export function collectChoiceOptionLabels(content: A2uiContent | undefined | null): Map<string, string> {
  const labels = new Map<string, string>()
  if (!content || !Array.isArray(content.components)) return labels
  for (const node of content.components) {
    const choice = parseChoice(node)
    if (choice) for (const o of choice.options) labels.set(o.id, o.label)
    const decision = parseDecision(node)
    if (decision) for (const o of decision.options) labels.set(o.id, o.label)
  }
  return labels
}
```

`parseDecision` is declared later in the file than these two functions; that is fine — function declarations hoist. Keep the Decision block at the end so the file stays grouped by concern.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV npx vitest run src/a2ui/__tests__/controls.test.ts`
Expected: PASS, including the pre-existing `parseChoice` / `isAnswerable` tests.

- [ ] **Step 5: Typecheck**

Run: `env -u NODE_ENV npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/a2ui/controls.ts src/a2ui/__tests__/controls.test.ts
git commit -m "feat(a2ui): parse the Decision control primitive

Options, three same-direction risk scales, the undo-action vs
undo-damage split, and horizon. Feeds the existing option-id
collectors, so the answer endpoint validates a Decision pick with
no server change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Render the card (`controlComponents.tsx` + `catalog.tsx`)

**Files:**
- Modify: `src/a2ui/controlComponents.tsx`
- Modify: `src/a2ui/catalog.tsx:23` (import) and the catalog object near `catalog.tsx:376`
- Test: `src/a2ui/__tests__/DecisionControl.test.tsx` (create)

**Interfaces:**
- Consumes from Task 1: `parseDecision`, `Rating`, `ParsedDecision`, `MAX_DECISION_OPTIONS`, `MAX_DECISION_RISKS`.
- Consumes existing: `useNoticeForm()` → `NoticeFormState` (`interactive`, `answered`, `submitting`, `selectedFor(choiceId)`, `text`, `toggleOption(choiceId, optionId, mode)`, `setText(value)`), `ControlFallback`, `NoticeFormProvider`.
- Produces for Task 3: `export function DecisionControl({ node }: { node: A2uiComponent }): ReactNode`, and the `HEAT` tone table it reads.

**Design notes the implementer needs:**

The form context holds **one** `text` value per point (`usePointAnswerForm.ts:45`), and the card's comment box binds to it via `form.setText`. That is why R7 needs no endpoint change. It also means a `Decision` plus a sibling `TextInput` renders two boxes writing the same string — the renderer does not deduplicate, and Step 1's test pins that as known behavior rather than a surprise.

Selection uses the Decision node's own `id` as the choice-group key, exactly as `ChoiceControl` does, so a Decision and a Choice on one surface stay independent. Mode is always `'single'` — you take one path.

- [ ] **Step 1: Write the failing tests**

Create `src/a2ui/__tests__/DecisionControl.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { A2uiComponent } from '../../domain/types'
import { DecisionControl, NoticeFormProvider, type NoticeFormState } from '../controlComponents'

function form(overrides: Partial<NoticeFormState> = {}): NoticeFormState {
  return {
    interactive: true,
    answered: false,
    submitting: false,
    selectedFor: () => new Set<string>(),
    text: '',
    toggleOption: vi.fn(),
    setText: vi.fn(),
    submit: vi.fn(),
    ...overrides,
  }
}

function renderDecision(node: A2uiComponent, state: NoticeFormState = form()): NoticeFormState {
  render(<NoticeFormProvider value={state}><DecisionControl node={node} /></NoticeFormProvider>)
  return state
}

const FULL: A2uiComponent = {
  component: 'Decision',
  id: 'd',
  options: [
    { id: 'worktree', label: 'Isolated worktree', gain: 'No stomping.', cost: '~400ms each.', wrongIf: 'Hands mostly read.' },
    { id: 'locks', label: 'Advisory locks', gain: 'Zero setup.', cost: 'Stale locks.', wrongIf: 'Two hands write one file.' },
  ],
  risks: [{ label: 'Stale lock wedges the fleet', severity: 'severe', likelihood: 'possible', discoverability: 'silent', note: 'Nothing alerts.' }],
  reversal: { action: 'costly', damage: 'days', note: 'Backfill must re-run.' },
  horizon: { span: 'permanent', until: 'The migration writes rows we cannot un-write.' },
}

describe('DecisionControl', () => {
  it('renders one radio per option with its gain, cost, and wrong-if', () => {
    renderDecision(FULL)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(screen.getByText('Isolated worktree')).toBeTruthy()
    expect(screen.getByText('No stomping.')).toBeTruthy()
    expect(screen.getByText('~400ms each.')).toBeTruthy()
    expect(screen.getByText('Hands mostly read.')).toBeTruthy()
  })

  it('selects through the form context keyed by the Decision node id', () => {
    const state = renderDecision(FULL)
    fireEvent.click(screen.getAllByRole('radio')[1])
    expect(state.toggleOption).toHaveBeenCalledWith('d', 'locks', 'single')
  })

  it('renders every rating chip with its scale label', () => {
    renderDecision(FULL)
    for (const id of ['severity', 'likelihood', 'discoverability', 'action', 'damage', 'span']) {
      expect(screen.getByTestId(`decision-rating-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId('decision-rating-severity').textContent).toContain('severe')
    expect(screen.getByTestId('decision-rating-discoverability').textContent).toContain('silent')
  })

  it('carries heat as a data attribute so the ramp is assertable', () => {
    renderDecision(FULL)
    expect(screen.getByTestId('decision-rating-severity').getAttribute('data-heat')).toBe('3')
    expect(screen.getByTestId('decision-rating-likelihood').getAttribute('data-heat')).toBe('2')
    expect(screen.getByTestId('decision-rating-action').getAttribute('data-heat')).toBe('2')
  })

  it('renders an unrecognised rating verbatim and uncolored (R8)', () => {
    renderDecision({ ...FULL, risks: [{ label: 'r', severity: 'catastrophic' }] })
    const chip = screen.getByTestId('decision-rating-severity')
    expect(chip.textContent).toContain('catastrophic')
    expect(chip.getAttribute('data-heat')).toBe('unknown')
  })

  it('states the horizon `until` line', () => {
    renderDecision(FULL)
    expect(screen.getByTestId('decision-until').textContent).toContain('The migration writes rows we cannot un-write.')
  })

  it('always renders a comment box bound to the shared text field (R7)', () => {
    const state = renderDecision({ ...FULL, comment: undefined })
    const box = screen.getByTestId('decision-comment')
    expect(screen.getByText('Anything else?')).toBeTruthy()
    fireEvent.change(box, { target: { value: 'one more thing' } })
    expect(state.setText).toHaveBeenCalledWith('one more thing')
  })

  it('honors an author-supplied comment label and placeholder', () => {
    renderDecision({ ...FULL, comment: { label: 'Constraints?', placeholder: 'e.g. deadline' } })
    expect(screen.getByText('Constraints?')).toBeTruthy()
    expect(screen.getByTestId('decision-comment').getAttribute('placeholder')).toBe('e.g. deadline')
  })

  it('degrades a malformed block alone, leaving the options standing (R9)', () => {
    renderDecision({ ...FULL, risks: 'garbage', reversal: 42, horizon: { span: 'permanent' } })
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByTestId('decision-risks-fallback')).toBeTruthy()
    expect(screen.getByTestId('decision-reversal-fallback')).toBeTruthy()
    expect(screen.getByTestId('decision-horizon-fallback')).toBeTruthy()
  })

  it('degrades whole below the two-option floor', () => {
    renderDecision({ component: 'Decision', id: 'd', options: [{ id: 'a', label: 'A' }] })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByText(/needs at least two options/i)).toBeTruthy()
  })

  it('locks every control once answered', () => {
    renderDecision(FULL, form({ answered: true }))
    expect(screen.getAllByRole('radio').every(r => (r as HTMLInputElement).disabled)).toBe(true)
    expect((screen.getByTestId('decision-comment') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('renders inert with no form provider (read-only context)', () => {
    render(<DecisionControl node={FULL} />)
    expect(screen.getAllByRole('radio').every(r => (r as HTMLInputElement).disabled)).toBe(true)
  })
})
```

Also append to `src/a2ui/__tests__/A2uiRenderer.test.tsx` (its imports already include `isSupported` and `CATALOG`; add `A2uiComponent` to its existing `import type { A2uiContent } from '../../domain/types'` line, since `cost()` is typed against it):

```tsx
describe('Decision catalog entry', () => {
  it('is a supported component type', () => {
    expect(isSupported('Decision')).toBe(true)
  })

  it('charges its options and risks to the per-surface node budget', () => {
    const node: A2uiComponent = {
      component: 'Decision', id: 'd',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      risks: [{ label: 'r1' }, { label: 'r2' }],
    }
    expect(CATALOG.Decision.cost!(node)).toBeGreaterThanOrEqual(4)
  })

  it('charges nothing for a decision that degrades whole', () => {
    expect(CATALOG.Decision.cost!({ component: 'Decision', options: [] })).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u NODE_ENV npx vitest run src/a2ui/__tests__/DecisionControl.test.tsx src/a2ui/__tests__/A2uiRenderer.test.tsx`
Expected: FAIL — `DecisionControl` is not exported; `isSupported('Decision')` is false.

- [ ] **Step 3: Implement the render**

In `src/a2ui/controlComponents.tsx`, extend the `parseChoice` import to `import { parseChoice, parseDecision, type Rating } from './controls'`, then append:

```tsx
// ---------------------------------------------------------------------------
// Decision — one open decision, rendered as a card (Slate, 2026-08-06).
//
// A control, not a prose block: the radios and the tradeoff text come from ONE
// options declaration, so what the user picks and what they read about it can
// never drift. Selection is keyed by the Decision node's own id, exactly as a
// Choice group is, so the two coexist on one surface without clobbering.
// ---------------------------------------------------------------------------

// One tone per heat step, LITERAL class strings so Tailwind's JIT emits them
// (same discipline as catalog.tsx's STEP_NODE). The ramp is a single amber
// INTENSITY, not a hue shift: the palette reserves red for a failed action, and
// the only meaning color carries here is "this end is the dangerous one". The
// label beside the chip is what distinguishes one dimension from another.
const HEAT: readonly string[] = [
  'border-hairline bg-surface-hover text-ink-low',
  'border-hairline bg-surface-hover text-ink-mid',
  'border-hue-discussing/22 bg-hue-discussing/10 text-hue-discussing',
  'border-hue-discussing/40 bg-hue-discussing/20 text-hue-discussing',
]

// An unrecognised word is shown, never rated — so it gets the quietest tone and
// no amber at all. Coercing it either way would lie about a risk (R8).
const HEAT_UNKNOWN = 'border-hairline bg-surface-hover text-ink-low'

/** One `label VALUE` pair. Mono throughout — a rating is meta, not prose. */
function RatingChip({ label, rating }: { label: string; rating: Rating | null }): ReactNode {
  if (!rating) return null
  const tone = rating.heat === null ? HEAT_UNKNOWN : HEAT[rating.heat]
  return (
    <span className="inline-flex items-baseline gap-1.5" data-testid={`decision-rating-${label}`} data-heat={rating.heat === null ? 'unknown' : String(rating.heat)}>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-low">{label}</span>
      <span className={`font-mono text-[10px] uppercase tracking-[0.08em] rounded-[3px] border px-1.5 py-px ${tone}`}>
        {rating.value}
      </span>
    </span>
  )
}

/** A section label — the mono caps meta ramp shared with Text's h4/h5. */
function SectionLabel({ text }: { text: string }): ReactNode {
  return <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-low mt-2 mb-1">{text}</div>
}

/** Authored prose inside the card. `font-sans` is load-bearing: the run card
 *  defaults to mono, so an unpinned sentence renders as terminal output. */
function Prose({ text, testId }: { text: string; testId?: string }): ReactNode {
  if (!text) return null
  return <div className="font-sans text-[12.5px] leading-[1.5] text-ink-low" data-testid={testId}>{text}</div>
}

export function DecisionControl({ node }: { node: A2uiComponent }): ReactNode {
  const form = useNoticeForm()
  const parsed = parseDecision(node)
  if (!parsed) return <ControlFallback label="decision needs at least two options" />
  const disabled = !form.interactive || form.answered || form.submitting
  const choiceId = typeof node.id === 'string' && node.id ? node.id : ''
  const selected = form.selectedFor(choiceId)
  const { options, risks, risksMalformed, reversal, reversalMalformed, horizon, horizonMalformed, comment } = parsed

  return (
    <div className="flex flex-col my-1" data-testid="decision">
      <SectionLabel text="Options" />
      <div className="flex flex-col gap-2" role="radiogroup">
        {options.map(opt => (
          <label key={opt.id} className={`flex items-start gap-2 ${disabled ? 'opacity-70' : 'cursor-pointer'}`}>
            <input
              type="radio"
              name={`decision-${choiceId || 'default'}`}
              value={opt.id}
              checked={selected.has(opt.id)}
              disabled={disabled}
              onChange={() => form.toggleOption(choiceId, opt.id, 'single')}
              className="mt-1 accent-amber-500"
            />
            <span className="min-w-0">
              <span className="font-sans text-[13px] leading-[1.4] text-ink-high block">{opt.label}</span>
              {opt.gain && <span className="font-sans text-[12.5px] leading-[1.5] text-ink-mid block">{`+ ${opt.gain}`}</span>}
              {opt.cost && <span className="font-sans text-[12.5px] leading-[1.5] text-ink-mid block">{`− ${opt.cost}`}</span>}
              {opt.wrongIf && <span className="font-sans text-[12.5px] leading-[1.5] text-ink-low block">{`⚑ wrong if ${opt.wrongIf}`}</span>}
            </span>
          </label>
        ))}
      </div>

      {(risks.length > 0 || risksMalformed) && <SectionLabel text="Risks" />}
      {risksMalformed && <span className="text-xs italic text-amber-300/80" data-testid="decision-risks-fallback">⚠ decision: no readable risks</span>}
      {risks.map((risk, i) => (
        <div key={`${i}-${risk.label}`} className="flex flex-col gap-0.5 mb-2" data-testid="decision-risk">
          <div className="font-sans text-[13px] leading-[1.4] text-ink-high">{risk.label}</div>
          <div className="flex flex-row flex-wrap gap-x-3 gap-y-1">
            <RatingChip label="severity" rating={risk.severity} />
            <RatingChip label="likelihood" rating={risk.likelihood} />
            <RatingChip label="discoverability" rating={risk.discoverability} />
          </div>
          <Prose text={risk.note} />
        </div>
      ))}

      {(reversal || reversalMalformed) && <SectionLabel text="Reversal" />}
      {reversalMalformed && <span className="text-xs italic text-amber-300/80" data-testid="decision-reversal-fallback">⚠ decision: reversal needs how long to undo the action or the damage</span>}
      {reversal && (
        <div className="flex flex-col gap-0.5 mb-2">
          <div className="flex flex-row flex-wrap gap-x-3 gap-y-1">
            <RatingChip label="action" rating={reversal.action} />
            <RatingChip label="damage" rating={reversal.damage} />
          </div>
          <Prose text={reversal.note} />
        </div>
      )}

      {(horizon || horizonMalformed) && <SectionLabel text="Horizon" />}
      {horizonMalformed && <span className="text-xs italic text-amber-300/80" data-testid="decision-horizon-fallback">⚠ decision: horizon needs a span and an `until`</span>}
      {horizon && (
        <div className="flex flex-col gap-0.5 mb-2">
          <RatingChip label="span" rating={horizon.span} />
          <Prose text={`until: ${horizon.until}`} testId="decision-until" />
        </div>
      )}

      {/* The comment box is not optional (R7) — the user always has somewhere to
          say the thing the options did not anticipate. It binds to the point's
          single shared `text` field, which is why this needs no endpoint change.
          Consequence: a sibling TextInput on the same surface would be a second
          box writing this same string. */}
      <div className="flex flex-col gap-1 mt-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-low">{comment.label}</span>
        <textarea
          rows={3}
          value={form.text}
          placeholder={comment.placeholder}
          disabled={disabled}
          onChange={e => form.setText(e.target.value)}
          data-testid="decision-comment"
          className="w-full rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-500 focus:outline-none disabled:opacity-70"
        />
      </div>
    </div>
  )
}
```

Then register it in `src/a2ui/catalog.tsx`. Extend the import at line 23:

```tsx
import { ChoiceControl, TextInputControl, SubmitControl, DecisionControl } from './controlComponents'
```

Add `parseDecision` to the imports from `./controls` (add the import line if the file has none yet):

```tsx
import { parseDecision } from './controls'
```

And add the entry immediately after `Submit` in the `CATALOG` object:

```tsx
  // Decision: one open decision — options with their tradeoffs, risks scored on
  // three same-direction scales, the undo-action vs undo-damage split, and the
  // horizon. A control, not a display block: `parseDecision` is the single place
  // that decides what counts as a usable option, and the SAME parse feeds the
  // server's answer validation via collectChoiceOptionIds — so the pick and the
  // reasoning can never disagree. Fewer than two options degrades whole; a bad
  // risks/reversal/horizon block degrades alone.
  Decision: {
    // One Decision node draws a row per option and per risk, so it charges those
    // to the walker's per-SURFACE budget — the same reason Stepper charges.
    cost: (node) => {
      const d = parseDecision(node)
      return d ? d.options.length + d.risks.length : 0
    },
    render: (node) => <DecisionControl node={node} />,
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV npx vitest run src/a2ui/__tests__/DecisionControl.test.tsx src/a2ui/__tests__/A2uiRenderer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint the class names and typecheck**

Run: `env -u NODE_ENV npm run lint && env -u NODE_ENV npm run typecheck`
Expected: clean. If the linter rejects a class, it is not in `tailwind.theme.js` — fix the class, do not edit the theme.

- [ ] **Step 6: Commit**

```bash
git add src/a2ui/controlComponents.tsx src/a2ui/catalog.tsx src/a2ui/__tests__/DecisionControl.test.tsx src/a2ui/__tests__/A2uiRenderer.test.tsx
git commit -m "feat(a2ui): render the Decision card

Options with gain/cost/wrong-if, rating chips on a single amber
intensity ramp, the reversal split, the horizon until-line, and a
non-removable comment box bound to the point's shared text field.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `silent` × `permanent` emphasis bump

**Files:**
- Modify: `src/a2ui/controlComponents.tsx`
- Test: `src/a2ui/__tests__/DecisionControl.test.tsx`

**Interfaces:**
- Consumes from Task 2: `DecisionControl`, `RatingChip`, `HEAT`.
- Produces: nothing new exported. `RatingChip` gains a `flare?: boolean` prop.

**Why this is its own task and its own commit:** it is the one piece of cross-field inference on the card, and it brushes against the "no composite score" rule the spec sets. Keeping it isolated means it can be reverted with `git revert` without touching the rest of the card. If it is dropped, delete this task — nothing else depends on it.

**What it does:** a risk whose `discoverability` is `silent` on a card whose `horizon.span` is `permanent` is the combination worth staring at — nothing will alert you, and the decision never stops mattering. Those two chips render one step brighter. Emphasis only: no number is computed, nothing is sorted by it, and no other pair interacts.

- [ ] **Step 1: Write the failing tests**

Append to `src/a2ui/__tests__/DecisionControl.test.tsx`:

```tsx
describe('DecisionControl · silent × permanent emphasis', () => {
  const withRisk = (discoverability: string, span: string): A2uiComponent => ({
    component: 'Decision', id: 'd',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    risks: [{ label: 'r', discoverability, severity: 'severe' }],
    horizon: { span, until: 'x' },
  })

  it('flares both chips when a silent risk meets a permanent horizon', () => {
    renderDecision(withRisk('silent', 'permanent'))
    expect(screen.getByTestId('decision-rating-discoverability').getAttribute('data-flare')).toBe('true')
    expect(screen.getByTestId('decision-rating-span').getAttribute('data-flare')).toBe('true')
  })

  it('does not flare when only one half is present', () => {
    renderDecision(withRisk('subtle', 'permanent'))
    expect(screen.getByTestId('decision-rating-span').getAttribute('data-flare')).toBeNull()
    renderDecision(withRisk('silent', 'until-this-ships'))
    expect(screen.getByTestId('decision-rating-discoverability').getAttribute('data-flare')).toBeNull()
  })

  it('leaves every other chip unflared — this is the only cross-field inference', () => {
    renderDecision(withRisk('silent', 'permanent'))
    expect(screen.getByTestId('decision-rating-severity').getAttribute('data-flare')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u NODE_ENV npx vitest run src/a2ui/__tests__/DecisionControl.test.tsx -t "silent"`
Expected: FAIL — `data-flare` is null on both chips.

- [ ] **Step 3: Implement the flare**

In `src/a2ui/controlComponents.tsx`, add the flare tone beside `HEAT`:

```tsx
// The one cross-field emphasis on the card: a risk nothing will alert on,
// attached to a decision that never stops mattering. Brighter than heat 3, and
// deliberately NOT a score — nothing is computed, sorted, or thresholded on it.
const HEAT_FLARE = 'border-hue-discussing/60 bg-hue-discussing/25 text-hue-discussing'
```

Give `RatingChip` the prop:

```tsx
function RatingChip({ label, rating, flare = false }: { label: string; rating: Rating | null; flare?: boolean }): ReactNode {
  if (!rating) return null
  const tone = rating.heat === null ? HEAT_UNKNOWN : flare ? HEAT_FLARE : HEAT[rating.heat]
  return (
    <span
      className="inline-flex items-baseline gap-1.5"
      data-testid={`decision-rating-${label}`}
      data-heat={rating.heat === null ? 'unknown' : String(rating.heat)}
      {...(flare ? { 'data-flare': 'true' } : {})}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-low">{label}</span>
      <span className={`font-mono text-[10px] uppercase tracking-[0.08em] rounded-[3px] border px-1.5 py-px ${tone}`}>
        {rating.value}
      </span>
    </span>
  )
}
```

In `DecisionControl`, compute the condition after `parsed` is destructured and pass it to the two chips only:

```tsx
  // Emphasis, not a score: the combination the reader most needs to catch.
  const permanent = horizon?.span?.value === 'permanent'
  const flareFor = (risk: DecisionRisk) => permanent && risk.discoverability?.value === 'silent'
```

Then in the risk row, `<RatingChip label="discoverability" rating={risk.discoverability} flare={flareFor(risk)} />`, and on the horizon, `<RatingChip label="span" rating={horizon.span} flare={risks.some(flareFor)} />`.

Import the type: extend the `./controls` import in `controlComponents.tsx` to include `type DecisionRisk`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV npx vitest run src/a2ui/__tests__/DecisionControl.test.tsx`
Expected: PASS (all of Task 2's tests still pass too).

- [ ] **Step 5: Lint and typecheck**

Run: `env -u NODE_ENV npm run lint && env -u NODE_ENV npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/a2ui/controlComponents.tsx src/a2ui/__tests__/DecisionControl.test.tsx
git commit -m "feat(a2ui): flare a silent risk on a permanent-horizon decision

The one cross-field emphasis on the card: nothing will alert you, and
the decision never stops mattering. Emphasis only — no score is
computed, sorted, or thresholded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Composer template and the three docs

**Files:**
- Modify: `src/components/RunWorkspaceWidget/surfaceCatalog.ts`
- Test: `src/components/RunWorkspaceWidget/__tests__/surfaceCatalog.test.ts` (create if absent)
- Modify: `docs/the-slate.md`, `docs/slate-design-language.md`, `agent-skills/skills/slate-surface/SKILL.md`

**Interfaces:**
- Consumes: `SURFACE_CATALOG`, `searchSurfaceCatalog` from `surfaceCatalog.ts`.
- Produces: a `SurfaceTemplate` with `id: 'decision'`.

- [ ] **Step 1: Write the failing test**

Create `src/components/RunWorkspaceWidget/__tests__/surfaceCatalog.test.ts` (if the file exists, append the `describe` block):

```ts
import { describe, it, expect } from 'vitest'
import { SURFACE_CATALOG, searchSurfaceCatalog } from '../surfaceCatalog'

describe('decision template', () => {
  it('is in the catalog', () => {
    expect(SURFACE_CATALOG.some(t => t.id === 'decision')).toBe(true)
  })

  it('is findable by fuzzy search', () => {
    expect(searchSurfaceCatalog('decision')[0].id).toBe('decision')
    expect(searchSurfaceCatalog('dec').map(t => t.id)).toContain('decision')
  })

  it('names every scale value in its prompt so the agent cannot invent one', () => {
    const { prompt } = SURFACE_CATALOG.find(t => t.id === 'decision')!
    for (const v of ['annoying', 'costly', 'severe', 'unlikely', 'possible', 'likely',
                     'obvious', 'subtle', 'silent', 'trivial', 'cheap', 'one-way',
                     'minutes', 'hours', 'days', 'weeks+',
                     'until-next-commit', 'until-this-ships', 'while-the-code-lives', 'permanent']) {
      expect(prompt).toContain(v)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_ENV npx vitest run src/components/RunWorkspaceWidget/__tests__/surfaceCatalog.test.ts`
Expected: FAIL — no template with id `decision`.

- [ ] **Step 3: Add the template**

Append to the `SURFACE_CATALOG` array in `src/components/RunWorkspaceWidget/surfaceCatalog.ts`:

```ts
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
      'published, a person who already saw it. Do NOT add a TextInput — the Decision ' +
      'card renders its own comment box. Write it to .tinstar/slate/decision.json ' +
      '(id, headline, A2UI content, refresh recipe).',
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `env -u NODE_ENV npx vitest run src/components/RunWorkspaceWidget/__tests__/surfaceCatalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `docs/the-slate.md`**

In the "The `content` body is A2UI" section, extend the vocabulary sentence to name `Decision` alongside `Choice`, `TextInput`, and `Submit`:

> `Choice`, `TextInput`, `Submit`, and `Decision` (one open decision with its options, risks, reversal cost, and horizon) for interactive controls.

- [ ] **Step 6: Update `docs/slate-design-language.md`**

Add to the "A2UI primitives" bullet list, after `Stepper`:

```markdown
- **Decision** — one open decision, rendered as a card: options carrying `gain` / `cost` / `wrongIf`, risks scored on **severity · likelihood · discoverability**, a **reversal** split into how long to undo the *action* versus the *damage*, and a **horizon** (how long the decision keeps mattering) with an `until` line. Every scale runs **fine → alarming left to right** — including `discoverability`, whose values run `obvious → subtle → silent` so the dangerous end is one straight vertical read. The alarming end is an **amber intensity ramp** (`hue.discussing`), not a hue shift: red stays reserved for a failed action, and the label beside each chip is what distinguishes the dimensions. An unrecognised rating renders **verbatim and uncolored** — the host never coerces a risk word up or down, which is deliberately unlike `Stepper`'s unknown → `pending` (a neutral default is safe for progress and unsafe for risk). One cross-field emphasis only: a `silent` risk on a `permanent` horizon brightens those two chips. **No composite score** — these are ordinal scales and an FMEA-style RPN is arithmetic on labels. It owns its surface's single text field, so never pair it with a `TextInput`.
```

- [ ] **Step 7: Update `agent-skills/skills/slate-surface/SKILL.md`**

Add a row to the component table, after `Submit`:

```markdown
| `Decision` | `options` (`{ id, label, gain, cost, wrongIf }[]`, **2+ required**), `risks?`, `reversal?`, `horizon?`, `comment?` | One open decision as a card. `risks` is `{ label, severity, likelihood, discoverability, note? }[]` where severity is `annoying`\|`costly`\|`severe`, likelihood is `unlikely`\|`possible`\|`likely`, discoverability is `obvious`\|`subtle`\|`silent` — **all three run fine → alarming**, so `silent` means nothing would alert you. `reversal` is `{ action, damage, note? }`: `action` (`trivial`\|`cheap`\|`costly`\|`one-way`) is how long to undo the **action**, `damage` (`minutes`\|`hours`\|`days`\|`weeks+`) is how long to undo the **damage** — frequently different numbers. `horizon` is `{ span, until }` where span is `until-next-commit`\|`until-this-ships`\|`while-the-code-lives`\|`permanent`; `until` completes "this matters until…" and is **required** whenever span is set. Needs a `Submit` sibling. **Do not add a `TextInput`** — the card renders its own comment box and owns the surface's single text field. An unknown scale word renders verbatim and uncolored rather than being coerced. Fewer than two options degrades whole; a bad risks/reversal/horizon block degrades alone. |
```

Then add an authoring-guidance paragraph after the table:

```markdown
**Authoring a Decision card.** Use `permanent` for horizon when something survives an
undo — rows already written, mail already sent, an API already published, a person who
already saw it. Reverting the commit does not retract any of those, which is why horizon
and reversal are separate axes: a decision can be one commit to undo and still matter
forever. The `until` string is where you say out loud what survives. Name a **concrete**
cost on each option — "adds complexity" is filler; say where the complexity lands. And do
not compute a risk score: the scales are ordinal, an FMEA-style RPN multiplies labels, and
the host deliberately renders no total.
```

- [ ] **Step 8: Full test suite, lint, typecheck**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' && env -u NODE_ENV npm run lint && env -u NODE_ENV npm run typecheck`
Expected: all green. Fix any regression before committing.

- [ ] **Step 9: Commit**

```bash
git add src/components/RunWorkspaceWidget/surfaceCatalog.ts \
        src/components/RunWorkspaceWidget/__tests__/surfaceCatalog.test.ts \
        docs/the-slate.md docs/slate-design-language.md \
        agent-skills/skills/slate-surface/SKILL.md
git commit -m "feat(slate): Decision composer template and authoring docs

Adds the Decision entry to the '+ Add surface' catalog and documents
the primitive in the Slate reference, the design language, and the
slate-surface authoring skill.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verification

The unit tests do not prove the card looks right on a real run. After Task 4, verify by looking:

1. Write a Decision surface file into a live run's worktree at `.tinstar/slate/decision.json` — a point with `headline` plus the `content` tree from the spec's "The shape" section, and a `Submit` sibling.
2. Confirm it projects onto the run's card, that the radios are live, that the comment box accepts text, and that a submit locks the card to "✓ Answered".
3. Use the `tinstar-screenshot` skill to capture the card and **look at the image** — check that the amber chips read as a ramp, that prose is sans and labels are mono, and that nothing overflows the 260px column horizontally.

Frontend changes need `vite build --outDir dist/client` plus a hard reload on `:5273` — a stale bundle is a debugging trap. Do not restart the user's server; ask them to reload.

## Out of scope for this plan

Per the spec: no decision *record* state, no composite scoring, no per-option risk sets, and no cross-run querying of horizons. Do not add them.
