// @vitest-environment jsdom
//
// Guard for the COMMITTED reference example that
// `docs/solutions/conventions/authoring-a-skill-progress-tracker-surface.md`
// tells skill authors to copy: `docs/examples/slate/skill-progress-tracker.json`.
//
// Every gate in the real pipeline fails SILENTLY — a surface file with an invalid
// `content` is dropped by the watcher and simply never appears. So a doc example
// can rot into something that renders nothing, and nobody finds out until a skill
// author copies it. This test runs the committed example through the same gates
// the runtime uses (`parseA2uiContent`, then `A2uiRenderer`), so the example
// can't silently go invalid.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from '@testing-library/react'
import { parseA2uiContent } from '../schema'
import { A2uiRenderer, MALFORMED_SIGNAL } from '../A2uiRenderer'

// Resolved off the vitest root (the repo root) rather than `import.meta.url` —
// under the jsdom environment this module's own URL is an http:// one, which
// `fileURLToPath` rejects.
const EXAMPLE_PATH = join(process.cwd(), 'docs/examples/slate/skill-progress-tracker.json')

/** The four statuses `Stepper` understands (catalog.tsx `STEP_STATUSES`). */
const ALLOWED_STATUSES = ['pending', 'active', 'done', 'skipped']

/** The CE pipeline phases the example documents, in order. */
const CE_PHASES = ['Brainstorm', 'Plan', 'Work', 'Review', 'Compound']

interface ExampleFile {
  id?: unknown
  headline?: unknown
  author?: unknown
  anchor?: { kind?: unknown }
  content?: unknown
  refresh?: unknown
}

function loadExample(): ExampleFile {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as ExampleFile
}

describe('docs/examples/slate/skill-progress-tracker.json — the committed reference example', () => {
  it('is valid JSON with a non-empty headline and a stable id', () => {
    const example = loadExample()
    expect(typeof example.headline).toBe('string')
    expect((example.headline as string).trim().length).toBeGreaterThan(0)
    // The stable id is what makes a per-phase rewrite AMEND the panel (merge-by-id)
    // instead of spawning a duplicate one.
    expect(example.id).toBe('ce-pipeline')
  })

  it("declares anchor.kind 'surface' so it projects as a standalone diagram card", () => {
    expect(loadExample().anchor?.kind).toBe('surface')
  })

  it("is authored by 'agent' and carries NO refresh recipe (it is session-derived)", () => {
    const example = loadExample()
    expect(example.author).toBe('agent')
    // The vacuum test: a fresh, context-free author cannot reproduce "how far along
    // is this skill", so the tracker must NOT ship a self-contained recipe.
    expect(example.refresh).toBeUndefined()
  })

  it('passes parseA2uiContent — the same gate the watcher and renderer use', () => {
    const parsed = parseA2uiContent(loadExample().content)
    expect(parsed).not.toBeNull()
    // `root` must name a real component id, or the renderer degrades.
    expect(parsed!.components.some(c => c.id === parsed!.root)).toBe(true)
  })

  it('roots at a Stepper whose steps all carry an allowed status', () => {
    const parsed = parseA2uiContent(loadExample().content)!
    const root = parsed.components.find(c => c.id === parsed.root)!
    expect(root.component).toBe('Stepper')
    const steps = root.steps as Array<Record<string, unknown>>
    expect(Array.isArray(steps)).toBe(true)
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) {
      expect(typeof step.label).toBe('string')
      expect((step.label as string).trim().length).toBeGreaterThan(0)
      expect(ALLOWED_STATUSES).toContain(step.status)
    }
    expect(steps.map(s => s.label)).toEqual(CE_PHASES)
    // Exactly one live edge — the whole point of the tracker.
    expect(steps.filter(s => s.status === 'active')).toHaveLength(1)
  })

  it('renders through A2uiRenderer as the five CE phase rows, not a degrade fallback', () => {
    const parsed = parseA2uiContent(loadExample().content)
    const { container } = render(createElement(A2uiRenderer, { content: parsed }))
    expect(container.textContent).not.toContain(MALFORMED_SIGNAL)
    expect(container.textContent).not.toContain('unsupported component')
    const rows = container.querySelectorAll('[data-testid="stepper-step"]')
    expect(rows).toHaveLength(CE_PHASES.length)
    expect(Array.from(rows).map(r => r.querySelector('[data-testid="stepper-label"]')!.textContent)).toEqual(CE_PHASES)
    expect(Array.from(rows).map(r => (r as HTMLElement).dataset.status)).toEqual([
      'done',
      'done',
      'active',
      'pending',
      'pending',
    ])
  })
})
