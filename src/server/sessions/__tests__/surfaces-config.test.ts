import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_CONFIG, loadConfig } from '../config'
import {
  DEFAULT_RECOVERY_RETENTION_MS,
  DEFAULT_RECOVERY_SWEEP_MS,
} from '../../surfaces/recovery-retention'

function loadWith(user: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'tinstar-surfaces-cfg-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(user))
  return loadConfig({ _rootDir: dir })
}

describe('surfaces lifecycle config', () => {
  it('ships a seven-day recovery retention bound by default', () => {
    expect(BASE_CONFIG.surfaces).toEqual({
      recoveryRetentionMs: DEFAULT_RECOVERY_RETENTION_MS,
      recoverySweepMs: DEFAULT_RECOVERY_SWEEP_MS,
    })
    expect(loadWith({}).surfaces).toEqual(BASE_CONFIG.surfaces)
  })

  it('honours operator overrides and treats 0 as disable', () => {
    const cfg = loadWith({
      surfaces: { recoveryRetentionMs: 0, recoverySweepMs: 12_000 },
    })
    expect(cfg.surfaces.recoveryRetentionMs).toBe(0)
    expect(cfg.surfaces.recoverySweepMs).toBe(12_000)
  })
})
