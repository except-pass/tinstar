# Markdown Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rendered markdown view with mermaid diagram support and local-file linking to the file editor widget.

**Architecture:** A new `MarkdownRenderer` component renders markdown content using `react-markdown` + `remark-gfm`, with a lazy-loaded `MermaidBlock` sub-component for diagram code blocks. The existing `FileEditorWidget` gains a toggle button that swaps between Monaco and the rendered view. Link clicks dispatch a custom DOM event that `InfiniteCanvas` handles to spawn nearby editor widgets.

**Tech Stack:** react-markdown (installed), remark-gfm (new), mermaid (new, lazy-loaded)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/widgets/fileEditor/MarkdownRenderer.tsx` | Create | Rendered markdown view, MermaidBlock, link click handler, Tinstar-styled components |
| `src/widgets/fileEditor/FileEditorWidget.tsx` | Modify | Toggle state, header button, conditional render of MarkdownRenderer vs Monaco |
| `src/components/InfiniteCanvas.tsx` | Modify | Listen for `tinstar:open-linked-file` event, spawn + position new editor widget |

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install remark-gfm and mermaid**

```bash
npm install remark-gfm mermaid
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('remark-gfm'); require('mermaid'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add remark-gfm and mermaid for markdown renderer"
```

---

### Task 2: Create MarkdownRenderer component (core rendering)

**Files:**
- Create: `src/widgets/fileEditor/MarkdownRenderer.tsx`

- [ ] **Step 1: Create the MarkdownRenderer component**

Create `src/widgets/fileEditor/MarkdownRenderer.tsx` with the full component. This task builds the markdown rendering with styled components and link handling. Mermaid support is added in Task 3.

```tsx
import { useCallback, useId, type ComponentPropsWithoutRef } from 'react'
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
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors (the component isn't wired in yet, but it must compile).

- [ ] **Step 3: Commit**

```bash
git add src/widgets/fileEditor/MarkdownRenderer.tsx
git commit -m "feat: add MarkdownRenderer component with Tinstar-styled markdown and link handling"
```

---

### Task 3: Add MermaidBlock (lazy-loaded mermaid diagrams)

**Files:**
- Modify: `src/widgets/fileEditor/MarkdownRenderer.tsx`

- [ ] **Step 1: Add the MermaidBlock component**

Add this component above the `MarkdownRenderer` function in `MarkdownRenderer.tsx`:

```tsx
import { useCallback, useEffect, useId, useRef, useState, type ComponentPropsWithoutRef } from 'react'
```

(Update the existing import line to include `useEffect` and `useRef`.)

Add this component before `MarkdownRenderer`:

```tsx
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
```

- [ ] **Step 2: Wire MermaidBlock into the `code` component**

Replace the `code` entry in the `components` object with:

```tsx
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
```

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/widgets/fileEditor/MarkdownRenderer.tsx
git commit -m "feat: add lazy-loaded MermaidBlock for diagram rendering in markdown view"
```

---

### Task 4: Wire MarkdownRenderer into FileEditorWidget

**Files:**
- Modify: `src/widgets/fileEditor/FileEditorWidget.tsx`

- [ ] **Step 1: Add the rendered mode toggle state**

At the top of `FileEditorWidget.tsx`, add the import:

```tsx
import { MarkdownRenderer } from './MarkdownRenderer'
```

Inside the `FileEditorWidget` function, after `const language = getLanguage(widget.filePath)`, add:

```tsx
  const isMarkdown = language === 'markdown'
  const [rendered, setRendered] = useState(isMarkdown)
  const toggleRendered = useCallback(() => setRendered(prev => !prev), [])
```

- [ ] **Step 2: Add the "rendered" header button**

In the header bar, after the "wrap" button and before the "Open in Editor" button, add:

```tsx
        {isMarkdown && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={toggleRendered}
            className={`text-2xs font-mono px-2 py-0.5 rounded border flex-shrink-0 ${rendered ? 'border-primary/60 text-primary' : 'border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60'}`}
            title="Toggle rendered markdown view"
          >
            rendered
          </button>
        )}
```

- [ ] **Step 3: Hide diff/wrap buttons when in rendered mode**

Wrap the existing "diff" and "wrap" buttons so they are hidden in rendered mode. Change each button's outer expression:

For the diff button, wrap it:
```tsx
        {!rendered && (
          <button ... >diff</button>
        )}
```

For the wrap button, wrap it:
```tsx
        {!rendered && (
          <button ... >wrap</button>
        )}
```

- [ ] **Step 4: Add the rendered view to the body**

In the body section (`<div className="flex-1 min-h-0">`), add a new branch at the top of the conditional chain, before the `content === null` check:

```tsx
        {content !== null && rendered ? (
          <MarkdownRenderer
            content={content}
            filePath={widget.filePath}
            sessionId={widget.sessionId}
            widgetId={widget.id}
          />
        ) : content === null ? (
```

This inserts the rendered view as the first condition. The rest of the chain (loading, binary, diff, Monaco) remains unchanged.

- [ ] **Step 5: Register the toggle-rendered hotkey action**

In the `registerActionHandler` callback, add:

```tsx
      if (action === 'toggle-rendered' && isMarkdown) toggleRendered()
```

Add `toggleRendered` and `isMarkdown` to the `useEffect` dependency array for the action handler registration (which already has `toggleWordWrap`, `toggleDiff`, etc.).

Update the dependency array:
```tsx
  }, [widget.id, handleOpenInEditor, toggleWordWrap, toggleDiff, toggleRendered, isMarkdown])
```

- [ ] **Step 6: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/widgets/fileEditor/FileEditorWidget.tsx
git commit -m "feat: wire markdown rendered toggle into file editor widget"
```

---

### Task 5: Handle tinstar:open-linked-file in InfiniteCanvas

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

- [ ] **Step 1: Add the event listener**

Inside the `InfiniteCanvas` function, after the existing `useEffect` blocks (after the spawn animation effect around line 224), add a new effect:

```tsx
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleLinkedFile = async (e: Event) => {
      const { sessionId, filePath, sourceWidgetId } = (e as CustomEvent).detail as {
        sessionId: string
        filePath: string
        sourceWidgetId: string
      }

      const sourceLayout = getLayout(sourceWidgetId)
      const spawnX = sourceLayout ? sourceLayout.x + sourceLayout.width + 40 : 0
      const spawnY = sourceLayout ? sourceLayout.y : 0
      const spawnLayout = { x: spawnX, y: spawnY, width: 640, height: 480 }

      const res = await fetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, filePath }),
      })
      const json = await res.json() as { ok: boolean; data?: EditorWidget }
      if (!json.ok || !json.data) return
      insertLayout(json.data.id, spawnLayout)
      onEditorWidgetCreated?.(json.data)
    }

    container.addEventListener('tinstar:open-linked-file', handleLinkedFile)
    return () => container.removeEventListener('tinstar:open-linked-file', handleLinkedFile)
  }, [getLayout, insertLayout, onEditorWidgetCreated])
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/InfiniteCanvas.tsx
git commit -m "feat: handle tinstar:open-linked-file to spawn nearby editor widgets"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Start dev server with mock data**

```bash
TINSTAR_FAST_SIM=1 npm run dev
```

- [ ] **Step 2: Open a .md file in a file editor widget**

Verify:
- The "rendered" button appears in the header and is active by default
- Markdown renders with correct Tinstar styling (dark palette, Chakra Petch headings, cyan links)
- The "diff" and "wrap" buttons are hidden while in rendered mode
- Clicking "rendered" toggles back to Monaco editor view
- "diff" and "wrap" buttons reappear in Monaco mode

- [ ] **Step 3: Test mermaid rendering**

Open a `.md` file that contains a mermaid code block (or create a test file). Verify:
- The mermaid block renders as an SVG diagram
- The diagram uses dark theme colors matching Tinstar
- Invalid mermaid syntax shows a red error message

- [ ] **Step 4: Test link handling**

In rendered mode:
- Click an external URL → opens in system browser
- Click a relative `.md` link → spawns a new file editor widget positioned to the right
- Click a relative non-`.md` link → spawns a new file editor in Monaco mode
- Click an anchor link (`#heading`) → scrolls to the heading within the rendered view

- [ ] **Step 5: Commit any fixes**

If any issues were found and fixed, commit them:

```bash
git add -u
git commit -m "fix: address smoke test issues in markdown renderer"
```
