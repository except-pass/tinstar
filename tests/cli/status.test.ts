import { describe, it, expect } from 'vitest'
import { renderStatus } from '../../bin/tinstar/status.js'

describe('renderStatus', () => {
  it('formats a snapshot in human-readable mode', () => {
    const out = renderStatus({
      backend: { ok: true, url: 'http://localhost:5273' },
      workspaces: 1,
      projects: ['tinstar'],
      sessions: 2,
      templates: ['claude', 'marshal'],
      onboarding: null,
    }, false)
    expect(out).toContain('backend:    ok (http://localhost:5273)')
    expect(out).toContain('projects:   1 (tinstar)')
    expect(out).toContain('onboarding: complete')
  })

  it('returns JSON when --json passed', () => {
    const out = renderStatus({
      backend: { ok: false, url: 'http://localhost:5273', error: 'connect refused' },
      workspaces: 0, projects: [], sessions: 0, templates: [], onboarding: 'connect',
    }, true)
    const parsed = JSON.parse(out)
    expect(parsed.backend.ok).toBe(false)
    expect(parsed.onboarding).toBe('connect')
  })
})
