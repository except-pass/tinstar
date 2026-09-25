import { render, screen } from '@testing-library/react'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../components/WorkspaceShell', () => ({
  default: () => <div>workspace-shell</div>,
}))

import App from '../../../App'

describe('V5 shell when v6 is off', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('mounts WorkspaceShell and does not use the live config home', () => {
    expect(process.env.TINSTAR_CONFIG_HOME).not.toBe(join(homedir(), '.config', 'tinstar'))
    render(<App />)
    expect(screen.getByText('workspace-shell')).toBeInTheDocument()
    expect(screen.queryByTestId('v6-shell')).toBeNull()
  })
})
