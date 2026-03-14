// src/components/HotkeyPalette.tsx
import { useState, useEffect, useRef } from 'react'
import { HOTKEYS, type HotkeyDef } from '../hotkeys/registry'
import { useActiveScope } from '../hotkeys/ActiveScopeContext'

interface Props {
  open: boolean
  onClose: () => void
}

export function HotkeyPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const { scope } = useActiveScope()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const q = query.toLowerCase()
  const filtered = q
    ? HOTKEYS.filter(h => h.description.toLowerCase().includes(q) || h.keys.toLowerCase().includes(q))
    : HOTKEYS

  // Group by category
  const categories = [...new Set(filtered.map(h => h.category))]

  const isAvailable = (h: HotkeyDef) => {
    if (h.scope === 'global') return true
    if (h.scope === 'canvas') return scope === 'canvas'
    if (h.scope === 'widget') return scope === 'widget'
    return true
  }

  return (
    <div
      data-testid="hotkey-palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-lg overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-700">
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search hotkeys…"
            className="w-full bg-transparent text-slate-100 placeholder-slate-500 outline-none text-sm"
            data-testid="hotkey-palette-input"
          />
        </div>
        <div className="overflow-y-auto max-h-96 p-2">
          {categories.map(cat => (
            <div key={cat} className="mb-3">
              <div className="text-xs text-slate-500 uppercase tracking-wider px-2 py-1">{cat}</div>
              {filtered.filter(h => h.category === cat).map(h => (
                <div
                  key={h.id}
                  className={`flex items-center justify-between px-2 py-1.5 rounded text-sm ${isAvailable(h) ? 'text-slate-200' : 'text-slate-600'}`}
                  title={isAvailable(h) ? '' : `Available when ${h.scope} is focused`}
                >
                  <span>{h.description}</span>
                  <kbd className="text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">{h.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-slate-500 text-sm text-center py-4">No hotkeys match "{query}"</div>
          )}
        </div>
      </div>
    </div>
  )
}
