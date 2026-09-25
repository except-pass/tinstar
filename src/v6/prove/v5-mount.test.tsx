import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/WorkspaceShell', () => ({
  default: () => <div>workspace-shell</div>,
}))

import App from '../../App'

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name)
      if (name.isSymbolicLink()) {
        out.push(path)
        continue
      }
      if (name.isDirectory()) walk(path)
      else out.push(path)
    }
  }
  try { walk(root) } catch { /* empty config is fine */ }
  return out.sort()
}

describe('prove V5 mount', () => {
  afterEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('mounts the V5 workspace when v6 is off and writes nothing outside the temp config and temp home', () => {
    const config = process.env.TINSTAR_CONFIG_HOME ?? ''
    expect(config.startsWith(tmpdir())).toBe(true)
    expect(config).not.toBe(join(homedir(), '.config', 'tinstar'))
    const home = mkdtempSync(join(tmpdir(), 'prove-v5-home-'))
    writeFileSync(join(home, 'FIXTURE'), 'fixture\n')
    const previousHome = process.env.TINSTAR_V6_FM_HOME
    const previousFlag = process.env.TINSTAR_V6_FIXTURE
    process.env.TINSTAR_V6_FM_HOME = home
    delete process.env.TINSTAR_V6_FIXTURE
    const before = listFiles(config)
    try {
      localStorage.clear()
      window.history.replaceState({}, '', '/')
      render(<App />)
      expect(screen.getByText('workspace-shell')).toBeInTheDocument()
      expect(screen.queryByTestId('v6-shell')).toBeNull()
      expect(listFiles(config)).toEqual(before)
      expect(readdirSync(home)).toEqual(['FIXTURE'])
      expect(readFileSync(join(home, 'FIXTURE'), 'utf8')).toBe('fixture\n')
      expect(home.startsWith('/Users/wtg/repo/')).toBe(false)
      expect(home.startsWith('/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home')).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.TINSTAR_V6_FM_HOME
      else process.env.TINSTAR_V6_FM_HOME = previousHome
      if (previousFlag === undefined) delete process.env.TINSTAR_V6_FIXTURE
      else process.env.TINSTAR_V6_FIXTURE = previousFlag
      rmSync(home, { recursive: true, force: true })
    }
  })
})
