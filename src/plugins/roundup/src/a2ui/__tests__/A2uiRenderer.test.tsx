// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { A2uiContent } from '../../../../../domain/types'
import {
  A2uiRenderer,
  A2uiErrorBoundary,
  MALFORMED_SIGNAL,
  extractReadableText,
} from '../A2uiRenderer'

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
    expect(p!.className).toContain('font-bold')
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
    expect(a!.textContent).toBe('the PR')
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
