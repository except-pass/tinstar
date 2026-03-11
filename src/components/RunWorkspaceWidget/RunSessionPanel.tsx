import { useState, useRef, useEffect } from 'react'
import type { RecapEntry, DiffBlock } from '../../types'

function DiffView({ diff }: { diff: DiffBlock }) {
  return (
    <div className="border border-primary/15 bg-surface-base rounded-sm overflow-hidden mt-2">
      <div className="flex items-center gap-2 px-2 py-1 bg-primary/[0.06] border-b border-primary/15 text-2xs text-primary/60 font-mono">
        <span className="material-symbols-outlined text-xs">difference</span>
        {diff.filename}
        <span className="text-slate-600 ml-auto">{diff.header}</span>
      </div>
      <pre className="px-2 py-1.5 text-2xs leading-relaxed font-mono overflow-x-auto">
        {diff.lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'addition'
                ? 'text-accent-green bg-accent-green/[0.06]'
                : line.type === 'deletion'
                  ? 'text-accent-red bg-accent-red/[0.06]'
                  : line.type === 'header'
                    ? 'text-slate-500'
                    : 'text-slate-400'
            }
          >
            <span className="select-none text-slate-600 inline-block w-3">
              {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
            </span>
            {line.content}
          </div>
        ))}
      </pre>
    </div>
  )
}

function AgentMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 border border-primary/40 flex items-center justify-center bg-primary/10">
        <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
          smart_toy
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xs font-mono text-primary/50 tracking-wide">AGENT</span>
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
        </div>
        <p className="text-xs font-mono leading-relaxed text-slate-300">
          {entry.content}
        </p>
        {entry.diff && <DiffView diff={entry.diff} />}
      </div>
    </div>
  )
}

function UserMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex gap-3 flex-row-reverse">
      <div className="shrink-0 w-6 h-6 border border-slate-600 flex items-center justify-center bg-surface-raised">
        <span className="material-symbols-outlined text-slate-400 text-sm">person</span>
      </div>
      <div className="flex-1 min-w-0 text-right">
        <div className="flex items-center gap-2 justify-end mb-1">
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
          <span className="text-2xs font-mono text-slate-500 tracking-wide">YOU</span>
        </div>
        <p className="text-xs font-mono leading-relaxed text-primary/70 bg-primary/[0.04] p-2.5 border-r-2 border-primary/40 text-left">
          {entry.content}
        </p>
      </div>
    </div>
  )
}

function StatusMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-primary/15" />
      <div className="flex items-center gap-2 text-2xs font-mono text-primary/50 tracking-wide uppercase">
        <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse-glow shadow-[0_0_4px_#00f0ff]" />
        {entry.content}
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-primary/15" />
    </div>
  )
}

interface Props {
  recapEntries: RecapEntry[]
  rawLogs: string
}

export function RunSessionPanel({ recapEntries, rawLogs }: Props) {
  const [activeTab, setActiveTab] = useState<'recap' | 'raw_logs'>('recap')
  const [prompt, setPrompt] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [activeTab])

  return (
    <section className="flex-1 flex flex-col min-w-0 border-x border-primary/20 bg-surface-base">
      {/* Tab toggle */}
      <div className="flex items-center justify-center border-b border-primary/20 py-2 bg-surface-panel">
        <div className="flex border border-primary/25 rounded-sm overflow-hidden">
          {(['recap', 'raw_logs'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`
                px-5 py-1 text-2xs font-bold font-display tracking-[0.15em] uppercase transition-all
                ${activeTab === tab
                  ? 'bg-primary text-surface-base'
                  : 'text-primary/50 hover:text-primary hover:bg-primary/[0.06]'
                }
              `}
            >
              {tab === 'recap' ? 'Recap' : 'Raw_Logs'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto scrollbar-thin p-4">
        {activeTab === 'recap' ? (
          <div className="space-y-5">
            {recapEntries.map((entry) => {
              switch (entry.type) {
                case 'agent': return <AgentMessage key={entry.id} entry={entry} />
                case 'user': return <UserMessage key={entry.id} entry={entry} />
                case 'status': return <StatusMessage key={entry.id} entry={entry} />
              }
            })}
          </div>
        ) : (
          <pre className="text-2xs font-mono leading-relaxed text-slate-400 whitespace-pre-wrap">
            {rawLogs.split('\n').map((line, i) => (
              <div
                key={i}
                className={`py-px ${
                  line.includes('PASS') ? 'text-accent-green' :
                  line.includes('FAIL') ? 'text-accent-red' :
                  line.includes('claude-agent:') ? 'text-slate-300' :
                  line.includes('bench:') ? 'text-accent-amber/70' :
                  ''
                }`}
              >
                {line}
              </div>
            ))}
          </pre>
        )}
      </div>

      {/* Prompt input */}
      <div className="p-3 border-t border-primary/25 bg-surface-panel">
        <div className="relative flex items-center">
          <span className="absolute left-2.5 text-primary/30 text-2xs font-mono tracking-wider select-none">&gt;_</span>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Type command or prompt..."
            className="w-full bg-surface-base border border-primary/25 rounded-sm text-xs font-mono py-2 pl-8 pr-10
              focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50
              text-slate-100 placeholder:text-slate-600 tracking-wide transition-all"
          />
          <button className="absolute right-2 text-primary/60 hover:text-primary transition-colors">
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
          </button>
        </div>
      </div>
    </section>
  )
}
