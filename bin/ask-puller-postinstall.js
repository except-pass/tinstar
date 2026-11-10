import { run } from './tinstar/ask-puller.js'
await run(['upgrade'])

// Refresh enabled local voice on package updates without machine-specific scripts.
await import('./tinstar/voice.js').then(({ run }) => run(['upgrade'])).catch(() => {
  console.warn('Local voice model update unavailable. Text works; retry: tinstar voice install')
})
