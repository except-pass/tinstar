// Shared hotkey sidebar constants and components used by HotkeysSidebar and HierarchySidebar
import { useRef, useEffect } from 'react'
import type { Binding } from '../hotkeys/widgetTypes'
import { formatKey } from '../hotkeys/widgetTypes'

export const GLOBAL_KEYS: Array<{ key: string; label: string }> = [
  { key: ']',         label: 'Focus next waiting' },
  { key: '[',         label: 'Focus prev waiting' },
  { key: 'Shift+]',   label: 'Focus next session' },
  { key: 'Shift+[',   label: 'Focus prev session' },
  { key: '?',         label: 'Hotkeys' },
  { key: 'S',         label: 'New session' },
]

export const CANVAS_KEYS: Array<{ key: string; label: string }> = [
  { key: 'Ctrl+G',    label: 'Arrange grid' },
  { key: 'Ctrl+L',    label: 'Swim lanes' },
]

export const QUICKDRAW_KEYS: Array<{ key: string; label: string }> = [
  { key: '1–9',            label: 'Quick Draw' },
  { key: 'Ctrl+1–9',       label: 'Quick Draw assign' },
  { key: 'Ctrl+Shift+1–9', label: 'Quick Draw remove' },
]

export function KeyBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1 py-0 bg-surface-raised border border-white/20 rounded text-2xs font-mono text-slate-300">
      {formatKey(label)}
    </span>
  )
}

export function BindingRow({ binding, fireCount }: { binding: Binding | { key: string; label: string }; fireCount: number }) {
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = rowRef.current
    if (!el || fireCount === 0) return
    const scan = el.querySelector('.flourish-scan-line') as HTMLElement | null
    const ripple = el.querySelector('.flourish-ripple-ring') as HTMLElement | null
    el.classList.remove('flourish-ignite')
    scan?.classList.remove('flourish-scan-active')
    ripple?.classList.remove('flourish-ripple-active')
    void el.offsetWidth
    el.classList.add('flourish-ignite')
    scan?.classList.add('flourish-scan-active')
    ripple?.classList.add('flourish-ripple-active')
    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== 'ignite') return
      el.classList.remove('flourish-ignite')
      scan?.classList.remove('flourish-scan-active')
      ripple?.classList.remove('flourish-ripple-active')
      el.removeEventListener('animationend', onEnd)
    }
    el.addEventListener('animationend', onEnd)
    return () => el.removeEventListener('animationend', onEnd)
  }, [fireCount])

  return (
    <div ref={rowRef} className="relative flex items-center justify-between gap-2 py-0.5 overflow-hidden rounded-sm">
      <div className="flourish-scan-line" />
      <div className="flourish-ripple-ring" style={{ borderRadius: '2px' }} />
      <span className="text-2xs text-slate-400 truncate">{binding.label}</span>
      <KeyBadge label={binding.key} />
    </div>
  )
}
