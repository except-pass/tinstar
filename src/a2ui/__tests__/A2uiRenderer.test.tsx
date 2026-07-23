// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { A2uiContent } from '../../domain/types'
import {
  A2uiRenderer,
  A2uiErrorBoundary,
  MALFORMED_SIGNAL,
  extractReadableText,
} from '../A2uiRenderer'
import { isSupported } from '../catalog'

// The catalog's Mermaid entry dynamically imports 'mermaid'; mock it so the
// async render resolves deterministically (no fixed timeouts — CI is slower).
const mermaidRenderMock = vi.fn()
const mermaidInitMock = vi.fn()
vi.mock('mermaid', () => ({
  default: {
    initialize: (...a: unknown[]) => mermaidInitMock(...a),
    render: (...a: unknown[]) => mermaidRenderMock(...a),
  },
}))

beforeEach(() => {
  mermaidRenderMock.mockReset()
  mermaidInitMock.mockReset()
  mermaidRenderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })
})

afterEach(() => vi.restoreAllMocks())

/** Build a content envelope from a flat component list; `root` defaults to the
 *  first component's id. */
function content(components: A2uiContent['components'], root?: string): A2uiContent {
  return { root: root ?? (components[0]?.id as string), components }
}

describe('A2uiRenderer — host-themed rendering (R14/R15)', () => {
  it('renders a Text component to a themed paragraph', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Text', text: 'Hello board', variant: 'body' }])} />,
    )
    const p = container.querySelector('p')
    expect(p).not.toBeNull()
    expect(p!.textContent).toBe('Hello board')
  })

  it('renders a Text heading variant with heading styling', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Text', text: 'Heads up', variant: 'h2' }])} />,
    )
    const p = container.querySelector('p')
    // Design language: headings render in the Chakra display face, semibold, high ink.
    expect(p!.className).toContain('font-display')
    expect(p!.className).toContain('font-semibold')
    expect(p!.textContent).toBe('Heads up')
  })

  it('renders a nested unordered list (Column → List → items) with host classes and structure', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Column', children: ['list'] },
          { id: 'list', component: 'List', listStyle: 'unordered', children: ['a', 'b'] },
          { id: 'a', component: 'Text', text: 'first', variant: 'body' },
          { id: 'b', component: 'Text', text: 'second', variant: 'body' },
        ])}
      />,
    )
    const ul = container.querySelector('ul')
    expect(ul).not.toBeNull()
    expect(ul!.className).toContain('list-disc')
    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toBe('first')
    expect(items[1]!.textContent).toBe('second')
  })

  it('renders an ordered list as <ol> with decimal styling', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'List', listStyle: 'ordered', children: ['a'] },
          { id: 'a', component: 'Text', text: 'step one', variant: 'body' },
        ])}
      />,
    )
    const ol = container.querySelector('ol')
    expect(ol).not.toBeNull()
    expect(ol!.className).toContain('list-decimal')
  })

  it('renders a Link with the host link styling and correct href/label', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([{ id: 'root', component: 'Link', text: 'the PR', url: 'https://example.com/pr/1' }])}
      />,
    )
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a!.getAttribute('href')).toBe('https://example.com/pr/1')
    expect(a!.textContent).toContain('the PR') // + a ↗ external-jump affordance
    expect(a!.className).toContain('underline')
  })

  it('ignores a dynamic data binding on a static prop and renders without error', () => {
    // `text` is a binding object (a data-model reference) — the interactivity
    // slice will resolve it; this read-only slice shows the static form (empty)
    // and must not throw or degrade the whole notice.
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Text', text: { path: '/decision' } }])} />,
    )
    expect(container.querySelector('p')).not.toBeNull()
    expect(container.textContent).not.toContain(MALFORMED_SIGNAL)
  })
})

describe('A2uiRenderer — graceful degrade (R16)', () => {
  it('renders an inline fallback for an unsupported component type instead of throwing', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'HologramDeck', text: 'x' }])} />,
    )
    expect(container.textContent).toContain('unsupported component')
    expect(container.textContent).toContain('HologramDeck')
  })

  it('renders an inline fallback for an unresolvable child reference, keeping siblings', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Column', children: ['present', 'ghost'] },
          { id: 'present', component: 'Text', text: 'still here', variant: 'body' },
        ])}
      />,
    )
    expect(container.textContent).toContain('still here')
    expect(container.textContent).toContain('missing component')
  })

  // Covers AE7 (origin): a description that fails schema validation still shows
  // a readable body plus the malformed signal — never a blank card.
  it('shows the malformed signal and salvaged text when content fails validation', () => {
    // Not a valid envelope (no root/components) — fails the v0_9 schema.
    const bogus = { headline: 'ignored', text: 'salvage me' } as unknown as A2uiContent
    render(<A2uiRenderer content={bogus} />)
    expect(screen.getByText(new RegExp(MALFORMED_SIGNAL.replace(/[.'"]/g, '.')))).toBeTruthy()
    expect(screen.getByText(/salvage me/)).toBeTruthy()
  })

  it('degrades (not blanks) when root points at a missing component', () => {
    const { container } = render(
      <A2uiRenderer content={{ root: 'nowhere', components: [{ id: 'other', component: 'Text', text: 'hi' }] }} />,
    )
    expect(container.textContent).toContain(MALFORMED_SIGNAL)
    expect(container.textContent!.length).toBeGreaterThan(0)
  })

  it('renders a degrade fallback (non-blank) rather than nothing for undefined content', () => {
    const { container } = render(<A2uiRenderer content={undefined} />)
    expect(container.textContent).toContain(MALFORMED_SIGNAL)
  })
})

describe('A2uiErrorBoundary — per-notice isolation (R16)', () => {
  function Thrower(): never {
    throw new Error('mid-render explosion')
  }

  it('catches a throw and shows the malformed signal instead of crashing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <A2uiErrorBoundary source={{ text: 'rescued words' }}>
        <Thrower />
      </A2uiErrorBoundary>,
    )
    expect(container.textContent).toContain(MALFORMED_SIGNAL)
    expect(container.textContent).toContain('rescued words')
  })

  it('isolates a failing notice from its siblings (a bad card never crashes the board)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <div>
        <A2uiErrorBoundary source={null}>
          <Thrower />
        </A2uiErrorBoundary>
        <A2uiErrorBoundary source={null}>
          <div>healthy sibling</div>
        </A2uiErrorBoundary>
      </div>,
    )
    expect(container.textContent).toContain(MALFORMED_SIGNAL) // the failed one degraded
    expect(container.textContent).toContain('healthy sibling') // the sibling survived
  })
})

describe('A2uiRenderer — hardening guards', () => {
  it('bounds a diamond-shaped description (shared refs) instead of exploding', () => {
    // Each c_i names the same child twice, so a naive walk renders 2^N nodes.
    // Depth here is small (well under MAX_DEPTH); only the total-node budget saves it.
    const comps: A2uiContent['components'] = [{ id: 'root', component: 'Column', children: ['c0', 'c0'] }]
    for (let i = 0; i < 30; i++) {
      comps.push({ id: `c${i}`, component: 'Column', children: [`c${i + 1}`, `c${i + 1}`] })
    }
    comps.push({ id: 'c30', component: 'Text', text: 'leaf' })
    const started = performance.now()
    const { container } = render(<A2uiRenderer content={content(comps)} />)
    // Completes fast (budget stops it) and surfaces the "too large" fallback.
    expect(performance.now() - started).toBeLessThan(2000)
    expect(container.textContent).toContain('content too large to render')
  })

  it('renders a javascript: URL as plain text, never a clickable <a>', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([{ id: 'root', component: 'Link', text: 'click me', url: 'javascript:alert(1)' }])}
      />,
    )
    expect(container.querySelector('a')).toBeNull() // no anchor emitted
    expect(container.textContent).toContain('click me') // label still shown as text
  })

  it('allows http(s) and same-origin relative hrefs', () => {
    for (const url of ['https://example.com/x', '/local/path', '#anchor']) {
      const { container } = render(
        <A2uiRenderer content={content([{ id: 'root', component: 'Link', text: 'go', url }])} />,
      )
      expect(container.querySelector('a')?.getAttribute('href')).toBe(url)
    }
  })
})

describe('A2uiRenderer — interactive controls (U2/U3)', () => {
  function form(over: Partial<Parameters<typeof A2uiRenderer>[0]['form'] & object> = {}) {
    return {
      interactive: true,
      answered: false,
      submitting: false,
      selectedFor: () => new Set<string>(),
      text: '',
      toggleOption: vi.fn(),
      setText: vi.fn(),
      submit: vi.fn(),
      ...over,
    }
  }

  it('renders a single-select Choice as radios with the declared options', () => {
    render(
      <A2uiRenderer
        content={content([{ id: 'root', component: 'Choice', mode: 'single', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo' }] }])}
        form={form()}
      />,
    )
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeTruthy()
  })

  it('renders a multi-select Choice as checkboxes', () => {
    render(
      <A2uiRenderer
        content={content([{ id: 'root', component: 'Choice', mode: 'multi', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo' }] }])}
        form={form()}
      />,
    )
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })

  it('renders a TextInput as a textarea wired to the form', () => {
    const f = form()
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'TextInput', label: 'Notes' }])} form={f} />,
    )
    const ta = container.querySelector('textarea')
    expect(ta).not.toBeNull()
    fireEvent.change(ta!, { target: { value: 'hi' } })
    expect(f.setText).toHaveBeenCalledWith('hi')
  })

  it('a Submit control fires the form submit', () => {
    const f = form()
    render(<A2uiRenderer content={content([{ id: 'root', component: 'Submit', label: 'Go' }])} form={f} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(f.submit).toHaveBeenCalled()
  })

  it('degrades a malformed Choice (no options) to an inline marker, not a throw', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Choice' }])} form={form()} />,
    )
    expect(container.textContent).toContain('choice has no options')
    expect(container.textContent).not.toContain(MALFORMED_SIGNAL) // the card didn't crash
  })

  it('renders controls disabled when no interactive form is provided (read-only)', () => {
    render(
      <A2uiRenderer
        content={content([{ id: 'root', component: 'Choice', mode: 'single', options: [{ id: 'a', label: 'Alpha' }] }])}
      />,
    )
    expect((screen.getByRole('radio', { name: 'Alpha' }) as HTMLInputElement).disabled).toBe(true)
  })
})

describe('A2uiRenderer — Mermaid diagram component (Slate S1)', () => {
  // The vppOps acceptance case: a 7-step pipeline with a fork at ROUTE. Before
  // this component the only way to draw it was ASCII art inside a `Code` block.
  const VPP_PIPELINE = [
    'graph TD',
    '  INGEST --> NORMALIZE',
    '  NORMALIZE --> ENRICH',
    '  ENRICH --> ROUTE',
    '  ROUTE -->|matched| DISPATCH',
    '  ROUTE -->|unmatched| DROP',
    '  DISPATCH --> SETTLE',
  ].join('\n')

  it('knows the Mermaid type (isSupported), so it never hits the unsupported fallback', () => {
    expect(isSupported('Mermaid')).toBe(true)
  })

  it('renders a Mermaid node through the component, not an "unsupported component" marker', async () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'm', component: 'Mermaid', source: 'graph TD; A-->B' }])} />,
    )
    expect(container.textContent).not.toContain('unsupported component')
    // The component mounts in its async loading state before mermaid resolves.
    expect(container.textContent).toContain('Rendering diagram')
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
  })

  // Acceptance: the fork example renders as a real diagram, not a Code block.
  it('renders the vppOps pipeline (with the ROUTE fork) as a diagram', async () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'm', component: 'Mermaid', source: VPP_PIPELINE }])} />,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    // The agent's fork syntax reached mermaid verbatim.
    expect(mermaidRenderMock).toHaveBeenCalledWith(expect.any(String), VPP_PIPELINE)
    expect(container.querySelector('pre')).toBeNull() // not a Code block
  })

  it('renders a Mermaid node alongside a sibling Text inside a Column (walk intact)', async () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Column', children: ['m', 't'] },
          { id: 'm', component: 'Mermaid', source: 'graph TD; A-->B' },
          { id: 't', component: 'Text', text: 'the sibling survived', variant: 'body' },
        ])}
      />,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    // The diagram did not consume its sibling.
    expect(container.textContent).toContain('the sibling survived')
  })

  it('degrades a Mermaid node with a missing/non-string source instead of crashing the surface', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Column', children: ['m', 't'] },
          { id: 'm', component: 'Mermaid' }, // no source at all
          { id: 't', component: 'Text', text: 'still here', variant: 'body' },
        ])}
      />,
    )
    expect(container.textContent).toContain('empty diagram')
    expect(container.textContent).toContain('still here')
    expect(container.textContent).not.toContain(MALFORMED_SIGNAL) // the card didn't crash
  })

  // The catalog must hand the authored `theme` through to the component; without
  // this wiring the prop exists in the docs but does nothing.
  it("passes an authored theme:'hue' through the catalog to the renderer", async () => {
    const { container } = render(
      <A2uiRenderer
        content={content([{ id: 'm', component: 'Mermaid', source: 'graph TD; A-->B', theme: 'hue' }])}
      />,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    const vars = (mermaidInitMock.mock.calls[0]![0] as Record<string, unknown>)
      .themeVariables as Record<string, string>
    expect(vars.primaryBorderColor).toBe('#818cf8') // hue.open, not ink.low
  })

  it('falls back to the ink treatment when the authored theme is garbage', async () => {
    const { container } = render(
      <A2uiRenderer
        content={content([{ id: 'm', component: 'Mermaid', source: 'graph TD; A-->B', theme: { path: '/t' } }])}
      />,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    const vars = (mermaidInitMock.mock.calls[0]![0] as Record<string, unknown>)
      .themeVariables as Record<string, string>
    expect(vars.primaryBorderColor).toBe('#5c6b74') // ink.low
  })

  it('degrades a Mermaid node whose source fails to parse, keeping siblings (R6)', async () => {
    mermaidRenderMock.mockRejectedValueOnce(new Error('Parse error on line 1'))
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Column', children: ['m', 't'] },
          { id: 'm', component: 'Mermaid', source: 'this is not mermaid' },
          { id: 't', component: 'Text', text: 'still here', variant: 'body' },
        ])}
      />,
    )
    await waitFor(() => {
      expect(container.textContent).toContain('Parse error on line 1')
    })
    expect(container.textContent).toContain('still here')
    // A bad diagram is an inline notice, never a tripped error boundary.
    expect(container.textContent).not.toContain(MALFORMED_SIGNAL)
  })
})

describe('A2uiRenderer — Stepper progress rail (Slate S3)', () => {
  // The compound-engineering pipeline, the convention's first rider.
  const CE_STEPS = [
    { label: 'Brainstorm', status: 'done' },
    { label: 'Plan', status: 'done' },
    { label: 'Work', status: 'active', detail: 'implementing unit 2/4' },
    { label: 'Review', status: 'pending' },
    { label: 'Compound', status: 'pending' },
  ]

  /** Every rendered step row, in document order. */
  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="stepper-step"]'))
  }

  it('knows the Stepper type (isSupported), so it never hits the unsupported fallback', () => {
    expect(isSupported('Stepper')).toBe(true)
  })

  it('renders one row per step, labelled in authored order', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Stepper', steps: CE_STEPS }])} />,
    )
    expect(container.textContent).not.toContain('unsupported component')
    const labels = rows(container).map(r => r.querySelector('[data-testid="stepper-label"]')!.textContent)
    expect(labels).toEqual(['Brainstorm', 'Plan', 'Work', 'Review', 'Compound'])
  })

  it('gives a done step the emerald hue.resolved token and a ✓', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Stepper', steps: CE_STEPS }])} />,
    )
    const done = rows(container)[0]!
    expect(done.dataset.status).toBe('done')
    const node = done.querySelector('[data-testid="stepper-node"]')!
    expect(node.className).toContain('bg-hue-resolved')
    expect(node.textContent).toBe('✓')
    // Finished work sits at mid ink — present, not shouting.
    expect(done.querySelector('[data-testid="stepper-label"]')!.className).toContain('text-ink-mid')
  })

  it('gives the active step the live cyan token, the glow, and high-ink label (P4)', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Stepper', steps: CE_STEPS }])} />,
    )
    const active = rows(container).find(r => r.dataset.status === 'active')!
    const node = active.querySelector('[data-testid="stepper-node"]')!
    expect(node.className).toContain('bg-primary')
    expect(node.className).toContain('shadow-[0_0_14px_rgba(0,240,255,0.10)]')
    expect(active.querySelector('[data-testid="stepper-label"]')!.className).toContain('text-ink-high')
  })

  it('renders a pending step low-ink on the faint rail, and a skipped step dimmed + struck through', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          {
            id: 'root',
            component: 'Stepper',
            steps: [
              { label: 'Later', status: 'pending' },
              { label: 'Never', status: 'skipped' },
            ],
          },
        ])}
      />,
    )
    const [pending, skipped] = rows(container)
    expect(pending!.querySelector('[data-testid="stepper-node"]')!.className).toContain('bg-primary/12')
    expect(pending!.querySelector('[data-testid="stepper-label"]')!.className).toContain('text-ink-low')
    expect(skipped!.querySelector('[data-testid="stepper-node"]')!.className).toContain('bg-hue-dismissed')
    expect(skipped!.querySelector('[data-testid="stepper-label"]')!.className).toContain('line-through')
  })

  it('coerces an unknown status to pending instead of throwing', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Stepper', steps: [{ label: 'Mystery', status: 'whatever' }] },
        ])}
      />,
    )
    expect(container.textContent).not.toContain(MALFORMED_SIGNAL)
    expect(rows(container)[0]!.dataset.status).toBe('pending')
  })

  it('degrades a missing/non-array/empty steps prop to an inline marker, keeping siblings (R16)', () => {
    for (const steps of [undefined, 'brainstorm, plan, work', {}, [], [{ status: 'done' }]]) {
      const { container, unmount } = render(
        <A2uiRenderer
          content={content([
            { id: 'root', component: 'Column', children: ['s', 't'] },
            { id: 's', component: 'Stepper', ...(steps === undefined ? {} : { steps }) },
            { id: 't', component: 'Text', text: 'still here', variant: 'body' },
          ])}
        />,
      )
      expect(container.textContent).toContain('stepper: no steps to show')
      // The sibling still renders and the error boundary never trips.
      expect(container.textContent).toContain('still here')
      expect(container.textContent).not.toContain(MALFORMED_SIGNAL)
      expect(rows(container)).toHaveLength(0)
      unmount()
    }
  })

  it('drops label-less and non-object rows but keeps the valid ones, and renders a detail caption', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          {
            id: 'root',
            component: 'Stepper',
            steps: [
              'not an object',
              null,
              { status: 'done' },
              { label: '   ', status: 'done' },
              { label: 'Work', status: 'active', detail: 'implementing unit 2/4' },
            ],
          },
        ])}
      />,
    )
    const row = rows(container)
    expect(row).toHaveLength(1)
    expect(row[0]!.querySelector('[data-testid="stepper-label"]')!.textContent).toBe('Work')
    // The detail is reading prose, so it pins the sans face (the card is mono).
    const detail = row[0]!.querySelector('[data-testid="stepper-detail"]')!
    expect(detail.textContent).toBe('implementing unit 2/4')
    expect(detail.className).toContain('font-sans')
  })

  it('composes as a normal leaf inside a Column/Card body', () => {
    const { container } = render(
      <A2uiRenderer
        content={content([
          { id: 'root', component: 'Column', children: ['head', 'card'] },
          { id: 'head', component: 'Text', text: 'Pipeline', variant: 'h3' },
          { id: 'card', component: 'Card', child: 'st' },
          { id: 'st', component: 'Stepper', steps: CE_STEPS },
        ])}
      />,
    )
    expect(container.textContent).toContain('Pipeline')
    expect(rows(container)).toHaveLength(5)
    // A leaf: the Stepper never resolves children of its own.
    expect(container.querySelectorAll('[data-testid="stepper"]')).toHaveLength(1)
  })

  it('draws a connector between rows but not after the last one', () => {
    const { container } = render(
      <A2uiRenderer content={content([{ id: 'root', component: 'Stepper', steps: CE_STEPS }])} />,
    )
    expect(container.querySelectorAll('[data-testid="stepper-connector"]')).toHaveLength(CE_STEPS.length - 1)
  })
})

describe('extractReadableText', () => {
  it('salvages readable strings from a nested description and skips non-readable keys', () => {
    const value = {
      components: [
        { id: 'root', component: 'Text', text: 'a headline' },
        { id: 'x', component: 'Link', text: 'click', url: 'https://e.com' },
      ],
    }
    const out = extractReadableText(value)
    expect(out).toContain('a headline')
    expect(out).toContain('click')
    expect(out).toContain('https://e.com')
    // `component`/`id` are structural, not readable content
    expect(out).not.toContain('Text')
    expect(out).not.toContain('root')
  })

  it('returns empty string for a nullish or primitive value without throwing', () => {
    expect(extractReadableText(null)).toBe('')
    expect(extractReadableText(42)).toBe('')
  })
})
