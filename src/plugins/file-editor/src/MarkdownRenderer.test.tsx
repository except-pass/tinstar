// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
})
