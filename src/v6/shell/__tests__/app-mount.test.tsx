import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../App'

vi.mock('../../../components/WorkspaceShell', () => ({
  default: () => <div>workspace-shell</div>,
}))

describe('App mount', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('renders WorkspaceShell unless v6Shell or ?v6=1', () => {
    render(<App />)
    expect(screen.getByText('workspace-shell')).toBeInTheDocument()
  })

  it('mounts V6 from the preference', () => {
    localStorage.setItem('tinstar-ui-prefs', JSON.stringify({ v6Shell: true }))
    render(<App />)
    expect(screen.getByTestId('v6-shell')).toBeInTheDocument()
  })

  it('mounts V6 from ?v6=1', () => {
    window.history.replaceState({}, '', '/?v6=1')
    render(<App />)
    expect(screen.getByTestId('v6-shell')).toBeInTheDocument()
  })
})
