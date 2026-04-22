# Markdown Renderer Test

This file tests the rendered markdown view in the file editor widget.

## Features

### Text Formatting

Regular paragraph with **bold**, *italic*, and `inline code`.

### Links

- External: [Anthropic](https://anthropic.com)
- Relative markdown: [Design Spec](superpowers/specs/2026-04-17-markdown-renderer-design.md)
- Anchor: [Jump to Mermaid](#mermaid-diagram)

### Task List

- [x] Install dependencies
- [x] Create MarkdownRenderer
- [x] Add MermaidBlock
- [ ] Wire into FileEditorWidget
- [ ] Smoke test

### Table

| Feature | Status | Notes |
|---------|--------|-------|
| Headings | Done | Chakra Petch font |
| Code blocks | Done | Surface panel bg |
| Mermaid | Done | Lazy loaded |

### Blockquote

> This is a blockquote with primary border styling.

### Code Block

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`
}
```

### Mermaid Diagram

```mermaid
graph TD
    A[File Widget] -->|toggle| B[Rendered View]
    A -->|default| C[Monaco Editor]
    B --> D[react-markdown]
    B --> E[MermaidBlock]
    D --> F[Styled Components]
    E --> G[SVG Diagram]
```

### Sequence Diagram

```mermaid
sequenceDiagram
    participant U as User
    participant FW as FileWidget
    participant MR as MarkdownRenderer
    participant IC as InfiniteCanvas
    U->>FW: Click relative link
    FW->>MR: handleLinkClick
    MR->>IC: CustomEvent(tinstar:open-linked-file)
    IC->>IC: getLayout(source)
    IC->>IC: POST /api/editor-widgets
    IC->>IC: insertLayout(nearby)
```
