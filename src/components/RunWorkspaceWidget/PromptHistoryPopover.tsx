// src/components/RunWorkspaceWidget/PromptHistoryPopover.tsx
import { useEffect, useId, useRef, useState } from 'react'
import { hexToRgba } from '../runAccent'

interface Props {
  history: readonly string[]
  accent: string
  onSelect: (text: string) => void
  onClose: () => void
}

export function PromptHistoryPopover({ history, accent, onSelect, onClose }: Props) {
  const labelId = useId()
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onSelectRef = useRef(onSelect)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onSelectRef.current = onSelect }, [onSelect])
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  // Clamp selection when history changes.
  useEffect(() => {
    setSelected(i => Math.min(i, Math.max(history.length - 1, 0)))
  }, [history.length])

  // Scroll selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Global keydown: arrows / Enter / Esc. The popover is open only while mounted,
  // so capture at document level to win over the underlying textarea.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected(i => Math.min(i + 1, history.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(i => Math.max(i - 1, 0))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setSelected(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setSelected(Math.max(history.length - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = history[selected]
        if (item !== undefined) onSelectRef.current(item)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [history, selected])

  // Outside-click close.
  useEffect(() => {
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCloseRef.current()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [])

  return (
    <div
      ref={rootRef}
      data-testid="prompt-history-popover"
      className="bg-surface-panel border rounded animate-[history-in_110ms_ease-out]"
      style={{ borderColor: hexToRgba(accent, 0.3) }}
    >
      <div
        id={labelId}
        className="px-2 py-1 text-2xs font-mono uppercase tracking-wider border-b"
        style={{
          color: hexToRgba(accent, 0.6),
          borderColor: hexToRgba(accent, 0.2),
        }}
      >
        Recent Prompts
      </div>
      <ul
        ref={listRef}
        className="max-h-60 overflow-y-auto scrollbar-thin"
        role="listbox"
        aria-labelledby={labelId}
        aria-activedescendant={history.length > 0 ? `${labelId}-item-${selected}` : undefined}
      >
        {history.length === 0 && (
          <li className="px-2 py-3 text-xs font-mono text-slate-500 text-center">
            No history yet — send a prompt first
          </li>
        )}
        {history.map((item, i) => {
          const isSel = i === selected
          return (
            <li
              key={i}
              id={`${labelId}-item-${i}`}
              role="option"
              aria-selected={isSel}
              data-testid={`prompt-history-item-${i}`}
              onPointerDown={e => {
                e.preventDefault()
                onSelect(item)
              }}
              onMouseEnter={() => setSelected(i)}
              className="flex gap-2 px-2 py-1 text-xs font-mono cursor-pointer"
              style={{
                background: isSel ? hexToRgba(accent, 0.1) : 'transparent',
                borderLeft: `2px solid ${isSel ? accent : 'transparent'}`,
                color: 'rgb(226 232 240)', // slate-200
              }}
            >
              <span className="text-2xs text-slate-600 tabular-nums w-5 text-right select-none">
                {i + 1}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-words line-clamp-2">
                {item}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
