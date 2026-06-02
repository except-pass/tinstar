import { useCallback, useEffect, useId, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  content: string
  filePath: string
  sessionId: string
  widgetId: string
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
}

function resolveRelativePath(base: string, relative: string): string {
  const dir = base.substring(0, base.lastIndexOf('/'))
  const parts = dir.split('/')
  for (const segment of relative.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

// Module-scoped so its identity is stable — a fresh array each render would make
// react-markdown rebuild its processor and reparse on every re-render.
const REMARK_PLUGINS = [remarkGfm]

let mermaidIdCounter = 0

function MermaidBlock({ source }: { source: string }) {
  // Hold the rendered SVG in state rather than writing it into a ref'd div.
  // A ref-based approach deadlocks: the target div would only be mounted in the
  // 'ok' state, so containerRef.current is null while loading — the very moment
  // render() resolves — and the result gets discarded before state flips to 'ok'.
  const [svg, setSvg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++mermaidIdCounter}`
    setSvg(null)
    setErrorMsg(null)

    import('mermaid').then(async (mod) => {
      if (cancelled) return
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#0a0e12',
          primaryTextColor: '#cbd5e1',
          primaryBorderColor: '#00f0ff',
          lineColor: '#00a5b0',
          secondaryColor: '#0f1419',
          tertiaryColor: '#141c24',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: '11px',
        },
      })
      try {
        const { svg } = await mermaid.render(id, source)
        if (cancelled) return
        setSvg(svg)
      } catch (err) {
        if (cancelled) return
        setErrorMsg(err instanceof Error ? err.message : 'Invalid mermaid syntax')
      }
    }).catch((err) => {
      // The mermaid module chunk itself failed to load (e.g. a stale/missing
      // /assets/*.js after a rebuild). Without this catch the block would hang on
      // "Rendering diagram…" forever. Surface an error with a reload hint instead.
      if (cancelled) return
      const detail = err instanceof Error ? err.message : 'unknown error'
      setErrorMsg(`Couldn't load the diagram renderer (${detail}). Try reloading the page.`)
    })

    return () => { cancelled = true }
  }, [source])

  if (errorMsg !== null) {
    return (
      <pre className="bg-surface-panel border border-accent-red/30 rounded p-3 mb-3 overflow-x-auto">
        <code className="text-2xs font-mono text-accent-red">{errorMsg}</code>
      </pre>
    )
  }
  if (svg === null) {
    return <div className="text-2xs font-mono text-slate-500 py-2">Rendering diagram...</div>
  }
  return <div className="my-3 flex justify-center [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function MarkdownRenderer({ content, filePath, sessionId, widgetId }: Props) {
  const scrollId = useId()

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      const href = e.currentTarget.getAttribute('href')
      if (!href) return

      if (href.startsWith('#')) {
        const target = document.getElementById(`${scrollId}-${slugify(href.slice(1))}`)
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }

      if (href.startsWith('http://') || href.startsWith('https://')) {
        window.open(href, '_blank', 'noopener')
        return
      }

      const resolved = resolveRelativePath(filePath, href)
      const event = new CustomEvent('tinstar:open-linked-file', {
        bubbles: true,
        detail: { sessionId, filePath: resolved, sourceWidgetId: widgetId },
      })
      e.currentTarget.dispatchEvent(event)
    },
    [filePath, sessionId, widgetId, scrollId],
  )

  // Memoize so the renderer identities (esp. `code`) stay stable across re-renders.
  // react-markdown keys components by element type — a fresh `code` function each
  // render makes React remount MermaidBlock, wiping its rendered-SVG state back to
  // "Rendering diagram…" on every parent re-render (the widget re-renders on a timer
  // and on file-watch ticks). Stable identities keep the diagram mounted.
  const components = useMemo<ComponentPropsWithoutRef<typeof ReactMarkdown>['components']>(() => ({
    h1: ({ children }) => (
      <h1 id={`${scrollId}-${slugify(String(children))}`} className="text-lg font-display font-semibold text-slate-100 mt-6 mb-2 pb-1 border-b border-primary/30">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 id={`${scrollId}-${slugify(String(children))}`} className="text-base font-display font-semibold text-slate-100 mt-5 mb-2 pb-1 border-b border-primary/20">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 id={`${scrollId}-${slugify(String(children))}`} className="text-sm font-display font-medium text-slate-200 mt-4 mb-1">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 id={`${scrollId}-${slugify(String(children))}`} className="text-xs font-display font-medium text-slate-200 mt-3 mb-1">
        {children}
      </h4>
    ),
    p: ({ children }) => <p className="text-xs text-slate-300 leading-relaxed mb-3">{children}</p>,
    a: ({ href, children }) => (
      <a href={href} onClick={handleLinkClick} className="text-primary hover:underline cursor-pointer">
        {children}
      </a>
    ),
    ul: ({ children }) => <ul className="list-disc list-inside text-xs text-slate-300 mb-3 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal list-inside text-xs text-slate-300 mb-3 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-primary/50 pl-3 italic text-slate-400 text-xs mb-3">
        {children}
      </blockquote>
    ),
    code: ({ className, children }) => {
      const match = className?.match(/language-(\w+)/)
      const lang = match?.[1]
      if (lang === 'mermaid') {
        return <MermaidBlock source={String(children).trim()} />
      }
      if (!match) {
        return <code className="bg-white/5 px-1 py-0.5 rounded text-2xs font-mono text-primary-dim">{children}</code>
      }
      return (
        <pre className="bg-surface-panel border border-white/10 rounded p-3 mb-3 overflow-x-auto">
          <code className="text-2xs font-mono text-slate-300 leading-relaxed">{children}</code>
        </pre>
      )
    },
    pre: ({ children }) => <>{children}</>,
    table: ({ children }) => (
      <div className="overflow-x-auto mb-3">
        <table className="text-2xs font-mono text-slate-300 border-collapse w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="border-b border-white/10">{children}</thead>,
    th: ({ children }) => <th className="px-2 py-1 text-left text-slate-200 font-medium">{children}</th>,
    td: ({ children }) => <td className="px-2 py-1 border-t border-white/5">{children}</td>,
    hr: () => <hr className="border-white/10 my-4" />,
    img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="max-w-full rounded border border-white/10 my-2" />,
    input: ({ checked, ...props }) => (
      <input
        {...props}
        checked={checked}
        disabled
        className="mr-1.5 accent-primary"
      />
    ),
  }), [handleLinkClick, scrollId])

  return (
    <div data-scrollable className="h-full overflow-y-auto px-4 py-3 font-mono">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
