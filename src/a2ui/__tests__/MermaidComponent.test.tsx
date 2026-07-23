// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MermaidComponent, normalizeTheme } from '../MermaidComponent'

// MermaidComponent dynamically imports 'mermaid'; mock it so the async render()
// outcome can be driven explicitly (no fixed timeouts — CI is slower than local).
const renderMock = vi.fn()
const initializeMock = vi.fn()
vi.mock('mermaid', () => ({
  default: {
    initialize: (...a: unknown[]) => initializeMock(...a),
    render: (...a: unknown[]) => renderMock(...a),
  },
}))

const PIPELINE = 'graph TD; A-->B'

beforeEach(() => {
  renderMock.mockReset()
  initializeMock.mockReset()
})

describe('MermaidComponent — async render (D5)', () => {
  it('shows the loading placeholder, then swaps in the rendered SVG', async () => {
    let resolveRender: (v: { svg: string }) => void = () => {}
    renderMock.mockReturnValue(new Promise((r) => { resolveRender = r }))

    const { container } = render(<MermaidComponent source={PIPELINE} />)
    // Placeholder is visible before render() resolves.
    expect(screen.getByText('Rendering diagram...')).toBeInTheDocument()

    resolveRender({ svg: '<svg data-testid="diagram">ok</svg>' })

    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    expect(screen.queryByText('Rendering diagram...')).toBeNull()
  })

  // RULING 1 (sizing). The Slate column is 260–560px and its scroll body is
  // overflow-x-hidden (#126), so the inline diagram must SCALE TO FIT — never a
  // horizontal scrollbar, never natural-size overflow.
  it('scales the inline diagram to fit the column instead of scrolling horizontally', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })

    const { container } = render(<MermaidComponent source={PIPELINE} />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    const trigger = container.querySelector('button')!
    // Shrink-to-fit via the SVG's viewBox; h-auto keeps the aspect ratio.
    const svgWrap = trigger.querySelector('div')!
    expect(svgWrap.className).toContain('[&_svg]:max-w-full')
    expect(svgWrap.className).toContain('[&_svg]:h-auto')
    // The #126 guard: no horizontal scroll anywhere in the inline view.
    expect(trigger.className).toContain('overflow-hidden')
    expect(container.innerHTML).not.toContain('overflow-x-auto')
  })

  it('passes the agent source through to mermaid.render under a unique id', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })

    const { container } = render(<MermaidComponent source={PIPELINE} />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    expect(renderMock).toHaveBeenCalledTimes(1)
    const [id, source] = renderMock.mock.calls[0]!
    expect(source).toBe(PIPELINE)
    expect(String(id)).toMatch(/^a2ui-mermaid-\d+$/)
  })
})

describe('MermaidComponent — degrade, never throw (D8)', () => {
  it('degrades to an inline amber line when render() rejects (invalid syntax)', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'))

    const { container } = render(<MermaidComponent source={'not a diagram'} />)

    await waitFor(() => {
      expect(container.textContent).toContain('Parse error on line 1')
    })
    // Degrade styling matches the renderer's NodeFallback marker.
    const line = container.firstElementChild as HTMLElement
    expect(line.className).toContain('text-amber-300/80')
    expect(line.className).toContain('italic')
    // The component itself is intact — nothing escaped as a throw.
    expect(screen.queryByText('Rendering diagram...')).toBeNull()
  })

  // The chunk-load failure (R4) needs the 'mermaid' module itself to reject, which
  // a per-test flag can't express here — vi.mock's factory result is cached for the
  // whole file. It lives in MermaidComponent.chunkFail.test.tsx instead.

  it.each([['   '], ['']])('degrades on an empty/whitespace source (%j) without calling render', (source) => {
    const { container } = render(<MermaidComponent source={source} />)
    expect(container.textContent).toContain('empty diagram')
    expect(renderMock).not.toHaveBeenCalled()
  })
})

describe('MermaidComponent — security + theme are pinned (D6 / D7-P4)', () => {
  async function initConfig(theme?: unknown) {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })
    const { container } = render(<MermaidComponent source={PIPELINE} theme={theme} />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    return initializeMock.mock.calls[0]![0] as Record<string, unknown>
  }

  it("initializes with securityLevel 'strict' — the source is untrusted, agent-authored", async () => {
    const cfg = await initConfig()
    expect(cfg.securityLevel).toBe('strict')
    // 'sandbox' would render into an iframe and break host theming/sizing.
    expect(cfg.securityLevel).not.toBe('sandbox')
  })

  it('suppresses mermaid\'s own error graphic so it cannot orphan a bomb over the canvas', async () => {
    const cfg = await initConfig()
    expect(cfg.suppressErrorRendering).toBe(true)
    expect(cfg.startOnLoad).toBe(false)
  })

  // R1 guard: the obvious move is to paste the file-editor MermaidBlock's config,
  // which uses cyan (#00f0ff / #00a5b0). The Slate design language reserves cyan
  // for the LIVE EDGE only (P4) — a static diagram must never use it, in EITHER
  // treatment. A cyan copy-paste fails here.
  it.each([[undefined], ['ink'], ['hue'], ['nonsense']])(
    'never leaks the reserved live-edge cyan into theme %j (P4)',
    async (theme) => {
      const cfg = await initConfig(theme)
      const vars = cfg.themeVariables as Record<string, string>
      for (const v of Object.values(vars)) {
        expect(v.toLowerCase()).not.toContain('#00f0ff') // primary (live edge)
        expect(v.toLowerCase()).not.toContain('#00a5b0') // primary.dim
      }
    },
  )

  it('defaults to the NEUTRAL ink.low monochrome treatment', async () => {
    const cfg = await initConfig()
    const vars = cfg.themeVariables as Record<string, string>
    expect(vars.primaryBorderColor).toBe('#5c6b74') // ink.low
    expect(vars.lineColor).toBe('#5c6b74') // ink.low
  })

  it('pins the dark Slate surface tokens so the diagram reads as part of the card', async () => {
    const cfg = await initConfig()
    const vars = cfg.themeVariables as Record<string, string>
    expect(cfg.theme).toBe('base')
    expect(vars.primaryColor).toBe('#141c24') // surface.hover
    expect(vars.primaryTextColor).toBe('#eaf1f5') // ink.high
    expect(vars.secondaryColor).toBe('#0f1419') // surface.raised
    expect(vars.tertiaryColor).toBe('#0a0e12') // surface.panel
  })
})

// RULING 2 — the author picks the treatment per diagram.
describe('MermaidComponent — author-chosen theme', () => {
  async function initConfig(theme?: unknown) {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })
    const { container } = render(<MermaidComponent source={PIPELINE} theme={theme} />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    return initializeMock.mock.calls[0]![0] as Record<string, unknown>
  }

  it("theme 'hue' uses the semantic hue.* palette for node borders and edges", async () => {
    const cfg = await initConfig('hue')
    const vars = cfg.themeVariables as Record<string, string>
    expect(vars.primaryBorderColor).toBe('#818cf8') // hue.open (indigo)
    expect(vars.lineColor).toBe('#6fcff6') // hue.waiting (sky)
    expect(vars.secondaryBorderColor).toBe('#4fe0a6') // hue.resolved (emerald)
    expect(vars.tertiaryBorderColor).toBe('#ffc266') // hue.discussing (amber)
    // Fills stay dark and labels stay ink.high so text remains legible.
    expect(vars.primaryColor).toBe('#141c24')
    expect(vars.primaryTextColor).toBe('#eaf1f5')
  })

  it("theme 'ink' is explicitly the same as the default (neutral monochrome)", async () => {
    const explicit = await initConfig('ink')
    initializeMock.mockReset()
    const implicit = await initConfig(undefined)
    expect(explicit.themeVariables).toEqual(implicit.themeVariables)
  })

  it('the theme choice never relaxes securityLevel', async () => {
    for (const theme of ['ink', 'hue', 'garbage', undefined]) {
      initializeMock.mockReset()
      const cfg = await initConfig(theme)
      expect(cfg.securityLevel).toBe('strict')
    }
  })

  // Content is agent-authored through a passthrough schema, so `theme` can be
  // literally anything. Everything unknown must land on 'ink' and never throw.
  it.each([
    ['unknown string', 'rainbow'],
    ['wrong case', 'HUE'],
    ['a number', 42],
    ['null', null],
    ['a data binding object', { path: '/theme' }],
    ['an array', ['hue']],
  ])('falls back to ink for %s', async (_label, theme) => {
    const cfg = await initConfig(theme)
    const vars = cfg.themeVariables as Record<string, string>
    expect(vars.primaryBorderColor).toBe('#5c6b74') // ink.low, not a hue
    expect(vars.lineColor).toBe('#5c6b74')
  })

  it('normalizeTheme is total — it maps every input to a known treatment', () => {
    expect(normalizeTheme('hue')).toBe('hue')
    expect(normalizeTheme('ink')).toBe('ink')
    for (const bad of [undefined, null, '', 'HUE', 'hues', 0, NaN, {}, [], () => {}]) {
      expect(normalizeTheme(bad)).toBe('ink')
    }
  })
})

// RULING 1 — click-to-expand. The expanded view MUST be portaled to document.body:
// the Slate lives inside a CSS-transformed infinite canvas, and a transform
// re-roots position:fixed onto the transformed ancestor, so an inline overlay
// lands displaced and scaled far from the cursor.
describe('MermaidComponent — click to expand', () => {
  async function renderDiagram() {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })
    const view = render(<MermaidComponent source={PIPELINE} />)
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    return view
  }

  it('is closed initially and opens the expanded view on click', async () => {
    const { container } = await renderDiagram()
    expect(screen.queryByTestId('mermaid-expanded')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))
    expect(screen.getByTestId('mermaid-expanded')).toBeTruthy()
    // The expanded copy carries the same SVG, at readable natural size.
    const panel = screen.getByTestId('mermaid-expanded-panel')
    expect(panel.querySelector('[data-testid="diagram"]')).not.toBeNull()
    expect(panel.querySelector('div')!.className).toContain('[&_svg]:max-w-none')
    expect(container).toBeTruthy()
  })

  it('portals the expanded view to document.body, escaping the canvas transform', async () => {
    const { container } = await renderDiagram()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))

    const overlay = screen.getByTestId('mermaid-expanded')
    // Rendered OUTSIDE the component's own container — that is the portal.
    expect(container.contains(overlay)).toBe(false)
    expect(document.body.contains(overlay)).toBe(true)
    // A fixed overlay is only correct because it is portaled out.
    expect(overlay.className).toContain('fixed')
  })

  it('gives the expanded panel data-scrollable so the canvas wheel handler yields', async () => {
    await renderDiagram()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))
    const panel = screen.getByTestId('mermaid-expanded-panel')
    expect(panel.hasAttribute('data-scrollable')).toBe(true)
    expect(panel.className).toContain('overflow-auto')
  })

  it('closes on Escape', async () => {
    await renderDiagram()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))
    expect(screen.getByTestId('mermaid-expanded')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('mermaid-expanded')).toBeNull()
  })

  it('closes on click-outside (the backdrop) but not on a click inside the panel', async () => {
    await renderDiagram()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))

    // A click on the diagram itself must NOT dismiss it.
    fireEvent.click(screen.getByTestId('mermaid-expanded-panel'))
    expect(screen.queryByTestId('mermaid-expanded')).toBeTruthy()

    // A click on the backdrop does.
    fireEvent.click(screen.getByTestId('mermaid-expanded'))
    expect(screen.queryByTestId('mermaid-expanded')).toBeNull()
  })

  it('closes via the explicit close button', async () => {
    await renderDiagram()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close diagram' }))
    expect(screen.queryByTestId('mermaid-expanded')).toBeNull()
  })

  it('unbinds the Escape listener on unmount (no leak, no stray close)', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = await renderDiagram()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(screen.queryByTestId('mermaid-expanded')).toBeNull()
    removeSpy.mockRestore()
  })

  it('offers no expand affordance while degraded (nothing to expand)', () => {
    const { container } = render(<MermaidComponent source={'  '} />)
    expect(container.textContent).toContain('empty diagram')
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull()
  })
})
