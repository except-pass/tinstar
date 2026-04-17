import { useCallback, useEffect, useId, useRef, useState, type ComponentPropsWithoutRef } from 'react'
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

let mermaidIdCounter = 0

function MermaidBlock({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++mermaidIdCounter}`

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
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = svg
        setState('ok')
      } catch (err) {
        if (cancelled) return
        setErrorMsg(err instanceof Error ? err.message : 'Invalid mermaid syntax')
        setState('error')
      }
    })

    return () => { cancelled = true }
  }, [source])

  if (state === 'loading') {
    return <div className="text-2xs font-mono text-slate-500 py-2">Rendering diagram...</div>
  }
  if (state === 'error') {
    return (
      <pre className="bg-surface-panel border border-accent-red/30 rounded p-3 mb-3 overflow-x-auto">
        <code className="text-2xs font-mono text-accent-red">{errorMsg}</code>
      </pre>
    )
  }
  return <div ref={containerRef} className="my-3 flex justify-center [&_svg]:max-w-full" />
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

  const components: ComponentPropsWithoutRef<typeof ReactMarkdown>['components'] = {
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
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-3 font-mono">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
