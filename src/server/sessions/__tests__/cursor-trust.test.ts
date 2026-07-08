import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cursorProjectSlug,
  cursorTrustMarkerPath,
  isCursorAgentTemplate,
  ensureCursorWorkspaceTrust,
} from '../cursor-trust'
import type { CliTemplate } from '../config'

describe('cursorProjectSlug', () => {
  it('strips the leading slash and maps the rest to dashes', () => {
    expect(cursorProjectSlug('/home/ubuntu/repo/tinstar')).toBe('home-ubuntu-repo-tinstar')
  })
  it('matches cursor slugs for dash-named worktree dirs', () => {
    expect(cursorProjectSlug('/home/ubuntu/repo/cmsandbox-worktrees/dataquality'))
      .toBe('home-ubuntu-repo-cmsandbox-worktrees-dataquality')
  })
})

describe('cursorTrustMarkerPath', () => {
  it('nests the marker under <cursorHome>/projects/<slug>/', () => {
    expect(cursorTrustMarkerPath('/c', '/home/ubuntu/repo/tinstar'))
      .toBe('/c/projects/home-ubuntu-repo-tinstar/.workspace-trusted')
  })
})

describe('isCursorAgentTemplate', () => {
  const t = (startCmd: string): CliTemplate => ({ name: 'x', startCmd, resumeCmd: startCmd })
  it('recognizes an `agent` command (even when renamed / adapter-less)', () => {
    expect(isCursorAgentTemplate(t('agent --yolo -- {prompt}'))).toBe(true)
  })
  it('is false for claude, shell, and codex commands', () => {
    expect(isCursorAgentTemplate(t('claude --session-id {sessionId} -- {prompt}'))).toBe(false)
    expect(isCursorAgentTemplate(t(':'))).toBe(false)
    expect(isCursorAgentTemplate(t('codex --full-auto -- {prompt}'))).toBe(false)
  })
  it('is false for null/undefined', () => {
    expect(isCursorAgentTemplate(null)).toBe(false)
    expect(isCursorAgentTemplate(undefined)).toBe(false)
  })
})

describe('ensureCursorWorkspaceTrust', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cursor-trust-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('writes a marker with cursor\'s exact shape when absent', () => {
    const ws = '/some/worktree/path'
    const ok = ensureCursorWorkspaceTrust(ws, '2026-07-08T00:00:00.000Z', home)
    expect(ok).toBe(true)
    const marker = cursorTrustMarkerPath(home, ws)
    expect(existsSync(marker)).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      trustedAt: '2026-07-08T00:00:00.000Z',
      workspacePath: ws,
    })
  })

  it('is idempotent — an existing marker is left untouched and still succeeds', () => {
    const ws = '/some/worktree/path'
    ensureCursorWorkspaceTrust(ws, '2026-07-08T00:00:00.000Z', home)
    const marker = cursorTrustMarkerPath(home, ws)
    const before = readFileSync(marker, 'utf8')
    const ok = ensureCursorWorkspaceTrust(ws, '2099-01-01T00:00:00.000Z', home)
    expect(ok).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe(before) // trustedAt not overwritten
  })

  it('returns false (never throws) when the marker can\'t be written', () => {
    // Point cursorHome at a path nested under a regular file, so mkdir fails.
    const filePath = join(home, 'not-a-dir')
    writeFileSync(filePath, 'x')
    expect(ensureCursorWorkspaceTrust('/ws', '2026-07-08T00:00:00.000Z', join(filePath, 'x'))).toBe(false)
  })
})
