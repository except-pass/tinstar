// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MarkdownRenderer } from './MarkdownRenderer'

// MermaidBlock dynamically imports 'mermaid'; mock it so we can drive the async
// render() outcome and assert the loading → success / loading → error transitions.
const renderMock = vi.fn()
const initializeMock = vi.fn()
vi.mock('mermaid', () => ({
  default: {
    initialize: (...a: unknown[]) => initializeMock(...a),
    render: (...a: unknown[]) => renderMock(...a),
  },
}))

const MERMAID_DOC = '```mermaid\ngraph TD; A-->B\n```'

function renderDoc() {
  return render(
    <MarkdownRenderer content={MERMAID_DOC} filePath="/x/doc.md" sessionId="s1" widgetId="editor-1" />,
  )
}

describe('MarkdownRenderer MermaidBlock', () => {
  beforeEach(() => {
    renderMock.mockReset()
    initializeMock.mockReset()
  })

  it('shows the loading state, then the rendered SVG on success', async () => {
    let resolveRender: (v: { svg: string }) => void = () => {}
    renderMock.mockReturnValue(new Promise((r) => { resolveRender = r }))

    const { container } = renderDoc()
    // Loading state visible before render() resolves.
    expect(screen.getByText('Rendering diagram...')).toBeInTheDocument()

    resolveRender({ svg: '<svg data-testid="diagram">ok</svg>' })

    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })
    expect(screen.queryByText('Rendering diagram...')).toBeNull()
  })

  it('shows an error message when render() rejects (invalid syntax)', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'))

    renderDoc()
    expect(screen.getByText('Rendering diagram...')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Parse error on line 1')).toBeInTheDocument()
    })
    expect(screen.queryByText('Rendering diagram...')).toBeNull()
  })

  it('keeps the rendered SVG mounted across parent re-renders (no flicker back to loading)', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram">ok</svg>' })

    // Parent that re-renders on demand while passing identical props — mirrors the
    // widget re-rendering on a timer / file-watch tick. Stable react-markdown
    // component + plugin identities must keep MermaidBlock mounted (no remount,
    // so its effect doesn't re-run and the SVG never flickers back to loading).
    let bump = () => {}
    function Parent() {
      const [, setN] = useState(0)
      bump = () => setN(n => n + 1)
      return <MarkdownRenderer content={MERMAID_DOC} filePath="/x/doc.md" sessionId="s1" widgetId="editor-1" />
    }
    const { container } = render(<Parent />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    })

    for (let i = 0; i < 3; i++) act(() => { bump() })

    expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
    expect(screen.queryByText('Rendering diagram...')).toBeNull()
    // A remount would re-run the effect and call render() again — assert it stayed at 1.
    expect(renderMock).toHaveBeenCalledTimes(1)
  })
})
