// src/components/HotkeyPalette.tsx
import { useState, useEffect, useRef, useMemo } from 'react'
import { getAllWidgets } from '../hotkeys/widgetRegistry'
import type { Binding } from '../hotkeys/widgetTypes'

interface Props {
  open: boolean
  onClose: () => void
}

export function HotkeyPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
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

  const q = open ? query.toLowerCase() : ''

  // Flatten all registered widget bindings into a searchable list
  const allBindings = useMemo(() => {
    const result: Array<{ widgetType: string; displayName: string; binding: Binding }> = []
    for (const def of getAllWidgets()) {
      for (const b of def.bindings) {
        result.push({ widgetType: def.type, displayName: def.displayName, binding: b })
      }
    }
    return result
  }, [])

  const filtered = q
    ? allBindings.filter(({ binding }) =>
        binding.label.toLowerCase().includes(q) || binding.key.toLowerCase().includes(q)
      )
    : allBindings

  // Group by widget displayName (replaces category)
  const groups = useMemo(() => {
    const map = new Map<string, Binding[]>()
    for (const { displayName, binding } of filtered) {
      if (!map.has(displayName)) map.set(displayName, [])
      map.get(displayName)!.push(binding)
    }
    return map
  }, [filtered])

  if (!open) return null

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
          {[...groups.entries()].map(([displayName, bindings]) => (
            <div key={displayName} className="mb-3">
              <div className="text-xs text-slate-500 uppercase tracking-wider px-2 py-1">{displayName}</div>
              {bindings.map(b => (
                <div
                  key={b.key}
                  className="flex items-center justify-between px-2 py-1.5 rounded text-sm text-slate-200"
                >
                  <span>{b.label}</span>
                  <kbd className="text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">{b.key}</kbd>
                </div>
              ))}
            </div>
          ))}
          {groups.size === 0 && (
            <div className="text-slate-500 text-sm text-center py-4">No hotkeys match "{query}"</div>
          )}
        </div>
      </div>
    </div>
  )
}
