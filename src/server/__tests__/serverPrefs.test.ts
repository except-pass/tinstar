import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadServerPrefs, saveServerPrefs, DEFAULT_SERVER_PREFS } from '../serverPrefs'

const ROOT = join(tmpdir(), 'tinstar-server-prefs-' + process.pid)
beforeEach(() => { rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true }) })
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('serverPrefs', () => {
  it('returns defaults when file missing', () => {
    expect(loadServerPrefs(ROOT)).toEqual(DEFAULT_SERVER_PREFS)
  })

  it('deep-merges existing file over defaults', () => {
    writeFileSync(join(ROOT, 'server-prefs.json'), JSON.stringify({ uploadMaxBytes: 5 * 1024 * 1024 }))
    expect(loadServerPrefs(ROOT)).toEqual({ ...DEFAULT_SERVER_PREFS, uploadMaxBytes: 5 * 1024 * 1024 })
  })

  it('save writes to disk and returns merged result', () => {
    const result = saveServerPrefs(ROOT, { uploadMaxBytes: 50 * 1024 * 1024 })
    expect(result.uploadMaxBytes).toBe(50 * 1024 * 1024)
    expect(existsSync(join(ROOT, 'server-prefs.json'))).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(ROOT, 'server-prefs.json'), 'utf8'))
    expect(onDisk.uploadMaxBytes).toBe(50 * 1024 * 1024)
  })

  it('save rejects uploadMaxBytes below 1 MB', () => {
    expect(() => saveServerPrefs(ROOT, { uploadMaxBytes: 100 })).toThrow(/uploadMaxBytes/)
  })

  it('save rejects non-integer uploadMaxBytes', () => {
    expect(() => saveServerPrefs(ROOT, { uploadMaxBytes: 1.5 })).toThrow(/uploadMaxBytes/)
  })

  it('survives a corrupt file by returning defaults', () => {
    writeFileSync(join(ROOT, 'server-prefs.json'), '{not json')
    expect(loadServerPrefs(ROOT)).toEqual(DEFAULT_SERVER_PREFS)
  })
})
