import { useEffect, useRef, useState } from 'react'
import type { CatalogEntry } from '../hooks/useWidgetCatalog'
import type { MoveTarget } from '../domain/moveTargets'
import { isIconUrl } from './agentIcon'

export interface AddWidgetPickerProps {
  entries: CatalogEntry[]
  defaultType: string
  anchor: { x: number; y: number }
  moveTargets: MoveTarget[]
  onPick: (entry: CatalogEntry) => void
  onMove: (id: string) => void
  onClose: () => void
}

/** Case-insensitive subsequence match: every char of `query` appears in `text` in order. */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

export function AddWidgetPicker({ entries, defaultType, anchor, moveTargets, onPick, onMove, onClose }: AddWidgetPickerProps) {
  const [mode, setMode] = useState<'create' | 'move'>('create')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const ordered = [
    ...entries.filter(e => e.type === defaultType),
    ...entries.filter(e => e.type !== defaultType),
  ]
  const q = query.trim()
  const filteredEntries = q ? ordered.filter(e => fuzzyMatch(q, e.label) || fuzzyMatch(q, e.type)) : ordered
  const filteredTargets = q ? moveTargets.filter(t => fuzzyMatch(q, t.label) || fuzzyMatch(q, t.id)) : moveTargets

  // In create mode the pinned "move existing" row is index 0 when available.
  const showPinned = mode === 'create' && moveTargets.length > 0
  const pinnedOffset = showPinned ? 1 : 0
  const createRowCount = pinnedOffset + filteredEntries.length
  const rowCount = mode === 'create' ? createRowCount : filteredTargets.length

  // Reset the active index whenever the visible list changes.
  useEffect(() => { setActive(0) }, [query, mode])

  const enterMoveMode = () => { setMode('move'); setQuery('') }
  const exitMoveMode = () => { setMode('create'); setQuery('') }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (mode === 'move') exitMoveMode()
        else onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); setActive(a => Math.min(a + 1, rowCount - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); setActive(a => Math.max(a - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (mode === 'move') { const t = filteredTargets[active]; if (t) onMove(t.id); return }
        if (showPinned && active === 0) { enterMoveMode(); return }
        const sel = filteredEntries[active - pinnedOffset]
        if (sel) onPick(sel)
      }
    }
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [mode, rowCount, showPinned, filteredEntries, filteredTargets, active, onPick, onMove, onClose])

  return (
    <div
      ref={ref}
      data-testid="add-widget-picker"
      className="fixed z-50 min-w-44 rounded-md border border-white/10 bg-slate-900/95 backdrop-blur p-1 shadow-xl"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <input
        data-testid="add-widget-search"
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={mode === 'move' ? 'Move which widget?' : 'Search widgets…'}
        className="mb-1 w-full rounded bg-white/5 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none focus:bg-white/10"
      />

      {mode === 'create' && (
        <>
          {showPinned && (
            <>
              <button
                data-testid="add-widget-move-existing"
                className={'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs '
                  + (active === 0 ? 'bg-primary/20 text-primary' : 'text-slate-200 hover:bg-white/5')}
                onMouseEnter={() => setActive(0)}
                onClick={enterMoveMode}
              >
                <span className="inline-flex h-4 w-4 items-center justify-center text-slate-400">↕</span>
                <span className="truncate">Move an existing widget here…</span>
              </button>
              <div className="my-1 border-t border-white/10" />
            </>
          )}
          {filteredEntries.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-slate-500">No widgets match</div>
          )}
          {filteredEntries.map((e, i) => {
            const idx = i + pinnedOffset
            return (
              <button
                key={e.pluginId ? `${e.pluginId}/${e.type}` : e.type}
                data-testid={`add-widget-option-${e.type}`}
                className={'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs '
                  + (idx === active ? 'bg-primary/20 text-primary' : 'text-slate-200 hover:bg-white/5')}
                onMouseEnter={() => setActive(idx)}
                onClick={() => onPick(e)}
              >
                {e.icon && isIconUrl(e.icon)
                  ? <img src={e.icon} className="h-4 w-4" alt="" />
                  : <span className="inline-flex h-4 w-4 items-center justify-center text-2xs font-mono text-slate-400">{e.label[0]}</span>}
                <span className="truncate">{e.label}</span>
                {e.type === defaultType && <span className="ml-auto text-2xs text-slate-500">default</span>}
              </button>
            )
          })}
        </>
      )}

      {mode === 'move' && (
        <>
          {filteredTargets.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-slate-500">No widgets match</div>
          )}
          {filteredTargets.map((t, i) => (
            <button
              key={t.id}
              data-testid={`add-widget-move-target-${t.id}`}
              className={'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs '
                + (i === active ? 'bg-primary/20 text-primary' : 'text-slate-200 hover:bg-white/5')}
              onMouseEnter={() => setActive(i)}
              onClick={() => onMove(t.id)}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center text-2xs font-mono text-slate-400">{t.label[0]}</span>
              <span className="truncate">{t.label}</span>
              {t.slots.length > 0 && <span className="ml-auto text-2xs text-slate-500">slot {t.slots.join(',')}</span>}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
