import { useState } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import './sessionConnection.css'

/** Small connection menu shared by the two controlled surfaces. */
export function SessionConnection() {
  const { connection, bridgeError, useThisTab, pendingFocus } = useDeskWorkspace()
  const [feedback, setFeedback] = useState('')
  if (!connection) return null
  return <details className="session-connection">
    <summary title="ChatGPT tab connection" aria-label={`ChatGPT tab ${connection.session_code}`}><span className="session-connection-label">ChatGPT · </span><span>{connection.session_code}</span>{pendingFocus ? ' ◷' : connection.designated ? ' ✓' : ''}</summary>
    <div className="session-connection-menu">
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(connection.scene_id); setFeedback('Full session ID copied.') } catch { setFeedback(`Session ID: ${connection.scene_id}`) } }}>Copy session ID</button>
      <button type="button" onClick={async () => { try { await useThisTab(); setFeedback('ChatGPT will use this tab.') } catch { setFeedback('Connection delayed. Try again.') } }}>Use this tab with ChatGPT</button>
      <p role="status">{bridgeError ? 'Connection delayed.' : pendingFocus ? 'Focus pending. Keep this tab in front to see it.' : feedback || (connection.designated ? 'ChatGPT uses this tab.' : 'Tell ChatGPT this code or choose this tab.')}</p>
    </div>
  </details>
}
