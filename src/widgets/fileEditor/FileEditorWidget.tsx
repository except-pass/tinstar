import { useRef, useEffect, useCallback, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { EditorWidget } from '../../domain/types'
import type { WidgetProps } from '../widgetComponentRegistry'
import { useFileWatch } from '../../hooks/useFileWatch'

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', html: 'html', css: 'css',
    sh: 'shell', bash: 'shell',
    sql: 'sql', xml: 'xml', toml: 'toml',
  }
  return map[ext] ?? 'plaintext'
}

function isBinaryOrLarge(content: string): boolean {
  if (content.length > 500 * 1024) return true
  const sample = content.slice(0, 8192)
  return sample.includes('\x00')
}

export function FileEditorWidget({ data }: WidgetProps) {
  const widget = data as EditorWidget
  const { content, connected, lastUpdatedAt } = useFileWatch(widget.sessionId, widget.filePath)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)

  const filename = widget.filePath.split('/').pop() ?? widget.filePath

  // When content arrives, update Monaco and restore scroll
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || content === null) return
    const scrollTop = ed.getScrollTop()
    const scrollLeft = ed.getScrollLeft()
    ed.setValue(content)
    // Restore scroll after Monaco processes the change
    const disposable = ed.onDidChangeModelContent(() => {
      ed.setScrollTop(scrollTop)
      ed.setScrollLeft(scrollLeft)
      disposable.dispose()
    })
  }, [content])

  // onMount fires once; useEffect above handles subsequent content updates
  const handleEditorMount = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    if (content !== null) ed.setValue(content)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenInEditor = useCallback(() => {
    fetch('/api/editor/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: widget.filePath, sessionId: widget.sessionId }),
    }).catch(() => {})
  }, [widget.filePath, widget.sessionId])

  const handleClose = useCallback(() => {
    fetch(`/api/editor-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!lastUpdatedAt) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [lastUpdatedAt])
  const secondsAgo = lastUpdatedAt ? Math.floor((now - lastUpdatedAt.getTime()) / 1000) : null

  return (
    <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
      {/* Header */}
      <div
        className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab"
      >
        <span className="text-primary text-xs">⬡</span>
        <span className="text-2xs font-mono text-slate-400 truncate flex-1">
          {[widget.task, widget.worktree, filename].filter(Boolean).join(' · ')}
        </span>
        <button
          onClick={handleOpenInEditor}
          className="text-2xs font-mono px-2 py-0.5 rounded border border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60 flex-shrink-0"
        >
          ↗ Open in Editor
        </button>
        <button
          onClick={handleClose}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-1"
          title="Close"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {content === null ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono">
            Loading…
          </div>
        ) : isBinaryOrLarge(content) ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono px-4 text-center">
            Binary or large file — open in external editor
          </div>
        ) : (
          <Editor
            language={getLanguage(widget.filePath)}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 11,
              lineNumbers: 'on',
              wordWrap: 'off',
            }}
            onMount={handleEditorMount}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-1 bg-surface-panel border-t border-white/10 flex-shrink-0">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: connected ? '#22c55e' : '#64748b' }}
        />
        <span className="text-2xs font-mono text-slate-500">
          {connected
            ? `watching · last updated ${secondsAgo === null ? '…' : secondsAgo + 's ago'}`
            : 'disconnected'}
        </span>
      </div>
    </div>
  )
}
