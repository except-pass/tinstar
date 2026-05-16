import { StrictMode } from 'react'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { resetApiBaseFromGlobal } from './apiClient'
import './index.css'
import './hotkeys/widgets'  // register hotkey WidgetDefinitions
import './widgets'           // register widget components
import App from './App'

// Expose React for external plugins loaded via importmap.
;(window as Window & { __tinstar_react?: typeof React }).__tinstar_react = React

// Tauri's Window::eval() injects window.__TINSTAR_API_BASE__ during
// PageLoadEvent::Started — but webview implementations differ on whether
// that runs strictly before module-script evaluation. apiClient.ts caches
// the base on first read, so we reset that cache here to guarantee the
// next read sees whatever the eval set, regardless of ordering.
resetApiBaseFromGlobal()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
