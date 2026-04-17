# File Widget Markdown Renderer with Mermaid Support

## Overview

Add a rendered markdown view to the file editor widget with mermaid diagram support, local file linking that spawns nearby widgets, and external URL handling.

## Toggle & State

- New **"rendered"** header button, same style as "diff" and "wrap"
- For `.md` files: defaults to ON (rendered mode)
- For all other files: button is hidden
- When in rendered mode, "diff" and "wrap" buttons are hidden (they only apply to Monaco)
- New hotkey action `toggle-rendered` registered in the existing action handler

## Markdown Rendering

- `react-markdown` (already installed) + `remark-gfm` (new dependency) for GitHub-flavored markdown
- Rendered view is a scrollable `div` with `overflow-y-auto`, replacing Monaco in the body area
- Styling via `react-markdown` `components` prop with Tailwind utility classes — no `@tailwindcss/typography` needed

### Styling (Tinstar dark palette)

- Headings: `text-slate-100`, `font-display` (Chakra Petch), `border-b border-primary/30`
- Body text: `text-slate-300`, `font-mono`, `text-xs` (11px, matching Monaco)
- Links: `text-primary hover:underline`
- Code blocks: `bg-surface-panel border border-white/10 rounded`, monospace
- Inline code: `bg-white/5 px-1 rounded`
- Tables: `border-white/10` grid lines
- Blockquotes: left border in primary, italic
- Task lists: styled checkboxes

## Mermaid Diagrams

- Lazy-load `mermaid` package (new dependency) — only imported when a mermaid code block is present
- `<MermaidBlock>` component:
  - Takes raw mermaid source as prop
  - On mount: `import('mermaid')` → `mermaid.render()` → SVG output
  - Shows "Rendering diagram..." placeholder while loading
  - Shows error message if syntax is invalid
  - SVG injected via `dangerouslySetInnerHTML` (mermaid's own output)
- Mermaid theme: `dark` with custom Tinstar palette colors
- Wired in via `components.code` — when language is `mermaid`, render `<MermaidBlock>` instead of `<code>`

## Link Handling

### External URLs (`http://`, `https://`)
- `window.open(href, '_blank')` — opens in system browser

### Relative markdown links (`./foo.md`, `../README.md`)
- Resolve path relative to current file's directory
- Dispatch `tinstar:open-linked-file` CustomEvent (bubbles) with `{ sessionId, filePath, sourceWidgetId }`
- InfiniteCanvas listens, creates widget via `POST /api/editor-widgets`, positions it **680px to the right** of source widget (width 640 + 40px gap)
- New `.md` widgets auto-default to rendered mode

### Non-markdown relative links (`./utils.ts`)
- Same spawn behavior, but opens in normal Monaco mode

### Anchor links (`#heading`)
- Scroll within the rendered view to the matching heading element

## New Dependencies

- `remark-gfm` — GitHub-flavored markdown plugin
- `mermaid` — diagram rendering (lazy-loaded)

## Files

- **New:** `src/widgets/fileEditor/MarkdownRenderer.tsx` — rendered view component + MermaidBlock
- **Modified:** `src/widgets/fileEditor/FileEditorWidget.tsx` — toggle state, rendered mode branch, header button, link event dispatch
- **Modified:** `src/components/InfiniteCanvas.tsx` — `tinstar:open-linked-file` event listener, spawn + position logic
