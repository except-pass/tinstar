import { useEffect, useState } from 'react'
import { useWindowEvent } from '../lib/windowEvents'
import { apiUrl } from '../apiClient'

/**
 * Receives `download:push` (an agent pushed a workspace file) and makes the
 * browser save it — no clicking, no hunting through the file tree. Triggers a
 * same-origin `<a download>` so the existing GET .../files/download route
 * (Content-Disposition: attachment) streams straight to Downloads, then flashes
 * a short confirmation toast.
 *
 * Mount once near the top of the app (WorkspaceShell). Every connected dashboard
 * tab downloads — acceptable for the single-user case.
 */

const TOAST_MS = 2500

function triggerBrowserDownload(href: string, filename: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export function DownloadPushToast() {
  const [toast, setToast] = useState<{ filename: string; id: number } | null>(null)
  const [shown, setShown] = useState(false)

  useWindowEvent('tinstar:download:push', (detail) => {
    if (!detail || typeof detail.url !== 'string' || typeof detail.filename !== 'string') return
    triggerBrowserDownload(apiUrl(detail.url), detail.filename)
    setToast({ filename: detail.filename, id: Date.now() })
  })

  // Drive the enter transition + auto-dismiss off each new toast.
  useEffect(() => {
    if (!toast) return
    const raf = requestAnimationFrame(() => setShown(true))
    const hide = setTimeout(() => setShown(false), TOAST_MS)
    const clear = setTimeout(() => setToast(null), TOAST_MS + 200)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(hide)
      clearTimeout(clear)
    }
  }, [toast])

  if (!toast) return null

  return (
    <div
      className={
        'fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-white/10 ' +
        'bg-surface-raised px-4 py-3 text-xs text-slate-200 shadow-lg transition-all duration-200 ' +
        (shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0')
      }
      role="status"
    >
      <span aria-hidden>⬇</span>
      <span>
        Downloaded <span className="font-medium">{toast.filename}</span>
      </span>
    </div>
  )
}
