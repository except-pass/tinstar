import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { openInChatGPT, type ChatGPTTarget } from './openInChatGPT'
import './openInChatGPT.css'

function PromptFallback({ launch, close }: { launch: ReturnType<typeof openInChatGPT>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), text = useRef<HTMLTextAreaElement>(null)
  const [feedback, setFeedback] = useState('')
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal()
    return () => { if (previous instanceof HTMLElement) previous.focus({ preventScroll: true }) }
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(launch.prompt)
      setFeedback('Prompt copied. Paste it into a new ChatGPT conversation and review before sending.')
    } catch {
      text.current?.focus(); text.current?.select()
      setFeedback('Clipboard unavailable. The prompt is selected; use your device’s Copy command.')
    }
  }
  return createPortal(<dialog ref={dialog} className="chatgpt-fallback" aria-label="ChatGPT prompt" onCancel={event => { event.preventDefault(); close() }} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <h2>Continue in ChatGPT</h2>
    <p>If the new tab or app has no prompt, copy this text and paste it into a new conversation. Review it before sending.</p>
    <p className="chatgpt-note">URL prefill depends on your browser and ChatGPT app. Only brief metadata and source links are included; no card body or logs.</p>
    <textarea ref={text} aria-label="Prompt to copy" readOnly value={launch.prompt} rows={9} />
    <p role="status">{feedback}</p>
    <div className="chatgpt-fallback-actions"><button type="button" onClick={() => void copy()}>Copy prompt</button><a href={launch.url} target="_blank" rel="noopener noreferrer">Open ChatGPT again ↗</a><button type="button" onClick={close}>Done</button></div>
  </dialog>, document.body)
}

/** Sibling to row controls, never nested inside the card's expand/Ask button. */
export function OpenInChatGPT({ target }: { target: ChatGPTTarget }) {
  const [launch, setLaunch] = useState<ReturnType<typeof openInChatGPT> | null>(null)
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const moved = (x: number, y: number) => {
    const start = gesture.current
    if (start && Math.hypot(x - start.x, y - start.y) > 8) start.moved = true
  }
  return <><button type="button" className="chatgpt-action" aria-label="Open in ChatGPT" title="Open in ChatGPT"
    onPointerDown={event => { event.stopPropagation(); gesture.current = { x: event.clientX, y: event.clientY, moved: false }; event.currentTarget.setPointerCapture?.(event.pointerId) }}
    onPointerMove={event => moved(event.clientX, event.clientY)} onPointerUp={event => moved(event.clientX, event.clientY)}
    onPointerCancel={() => { if (gesture.current) gesture.current.moved = true }}
    onTouchStart={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { gesture.current = null; event.stopPropagation() } }}
    onClick={event => {
      event.stopPropagation()
      if (event.detail !== 0 && gesture.current?.moved) { event.preventDefault(); return }
      const next = openInChatGPT(target)
      window.open(next.url, '_blank', 'noopener,noreferrer')
      setLaunch(next)
    }}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4M11 3h6v6M17 3l-9 9" /></svg></button>
    {launch && <PromptFallback launch={launch} close={() => setLaunch(null)} />}
  </>
}
