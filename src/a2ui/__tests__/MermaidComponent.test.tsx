// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MermaidComponent } from '../MermaidComponent'

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

  it('wraps a wide diagram in its own scroll box so it never widens the card (R2)', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })

    const { container } = render(<MermaidComponent source={PIPELINE} />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('overflow-x-auto')
    expect(wrapper.className).toContain('[&_svg]:max-w-full')
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
  async function initConfig() {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })
    const { container } = render(<MermaidComponent source={PIPELINE} />)
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
  // for the LIVE EDGE only (P4) — a static diagram must use neutral ink. A cyan
  // copy-paste fails here.
  it('themes edges and node borders in NEUTRAL ink.low, never the reserved cyan (P4)', async () => {
    const cfg = await initConfig()
    const vars = cfg.themeVariables as Record<string, string>
    expect(vars.primaryBorderColor).toBe('#5c6b74') // ink.low
    expect(vars.lineColor).toBe('#5c6b74') // ink.low
    for (const v of Object.values(vars)) {
      expect(v.toLowerCase()).not.toContain('#00f0ff') // primary (live edge)
      expect(v.toLowerCase()).not.toContain('#00a5b0') // primary.dim
    }
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
