import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listProjects,
  getProject,
  registerProject,
  unregisterProject,
  setProjectFlag,
  reorderProjects,
} from '../workspace'

const ROOT = join(tmpdir(), 'tinstar-workspace-projects-' + process.pid)
const FILE = join(ROOT, 'projects.json')

function writeRaw(data: unknown): void {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(FILE, JSON.stringify(data, null, 2))
}
function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(FILE, 'utf-8'))
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('project registry normalization', () => {
  it('normalizes a legacy all-string file, ordering by file position', () => {
    writeRaw({ alpha: '/a', beta: '/b', gamma: '/c' })
    const projects = listProjects(FILE)
    expect(projects.alpha).toEqual({ path: '/a', starred: false, hidden: false, order: 0 })
    expect(projects.beta).toEqual({ path: '/b', starred: false, hidden: false, order: 1 })
    expect(projects.gamma).toEqual({ path: '/c', starred: false, hidden: false, order: 2 })
  })

  it('reads a mixed old-string + new-object file, defaulting missing fields', () => {
    writeRaw({
      alpha: '/a',
      beta: { path: '/b', starred: true },
      gamma: { path: '/c', hidden: true, order: 5 },
    })
    const projects = listProjects(FILE)
    expect(projects.alpha).toEqual({ path: '/a', starred: false, hidden: false, order: 0 })
    expect(projects.beta).toEqual({ path: '/b', starred: true, hidden: false, order: 1 })
    expect(projects.gamma).toEqual({ path: '/c', starred: false, hidden: true, order: 5 })
  })

  it('round-trips a full new-object file unchanged', () => {
    const data = {
      alpha: { path: '/a', starred: true, hidden: false, order: 0 },
      beta: { path: '/b', starred: false, hidden: true, order: 1 },
    }
    writeRaw(data)
    expect(listProjects(FILE)).toEqual(data)
  })

  it('returns {} for a missing file', () => {
    expect(listProjects(FILE)).toEqual({})
  })
})

describe('getProject', () => {
  it('returns the path string for legacy and new forms', () => {
    writeRaw({ alpha: '/a', beta: { path: '/b', starred: true, hidden: false, order: 1 } })
    expect(getProject(FILE, 'alpha')).toBe('/a')
    expect(getProject(FILE, 'beta')).toBe('/b')
  })
  it('returns null for an unknown project', () => {
    writeRaw({ alpha: '/a' })
    expect(getProject(FILE, 'nope')).toBeNull()
  })
})

describe('registerProject', () => {
  it('appends a new project with order = max + 1', () => {
    writeRaw({ alpha: { path: '/a', starred: false, hidden: false, order: 3 } })
    registerProject(FILE, 'beta', '/b')
    const projects = listProjects(FILE)
    expect(projects.beta).toEqual({ path: '/b', starred: false, hidden: false, order: 4 })
  })
  it('starts order at 0 for the first project', () => {
    registerProject(FILE, 'alpha', '/a')
    expect(listProjects(FILE).alpha!.order).toBe(0)
  })
  it('preserves flags/order and only updates path on an existing project', () => {
    writeRaw({ alpha: { path: '/old', starred: true, hidden: true, order: 7 } })
    registerProject(FILE, 'alpha', '/new')
    expect(listProjects(FILE).alpha).toEqual({ path: '/new', starred: true, hidden: true, order: 7 })
  })
  it('upgrades a legacy file to object form on write', () => {
    writeRaw({ alpha: '/a' })
    registerProject(FILE, 'beta', '/b')
    const raw = readRaw()
    expect(typeof raw.alpha).toBe('object')
    expect(raw.alpha).toEqual({ path: '/a', starred: false, hidden: false, order: 0 })
  })
})

describe('unregisterProject', () => {
  it('removes a project and returns true', () => {
    writeRaw({ alpha: '/a', beta: '/b' })
    expect(unregisterProject(FILE, 'alpha')).toBe(true)
    expect(listProjects(FILE).alpha).toBeUndefined()
    expect(listProjects(FILE).beta).toBeDefined()
  })
  it('returns false for an unknown project', () => {
    writeRaw({ alpha: '/a' })
    expect(unregisterProject(FILE, 'nope')).toBe(false)
  })
})

describe('setProjectFlag', () => {
  beforeEach(() => {
    writeRaw({ alpha: { path: '/a', starred: false, hidden: false, order: 0 } })
  })
  it('sets starred independently, leaving hidden untouched', () => {
    const r = setProjectFlag(FILE, 'alpha', { starred: true })
    expect(r).toEqual({ path: '/a', starred: true, hidden: false, order: 0 })
    expect(listProjects(FILE).alpha!.hidden).toBe(false)
  })
  it('sets hidden independently, leaving starred untouched', () => {
    setProjectFlag(FILE, 'alpha', { starred: true })
    const r = setProjectFlag(FILE, 'alpha', { hidden: true })
    expect(r).toEqual({ path: '/a', starred: true, hidden: true, order: 0 })
  })
  it('can turn a flag back off', () => {
    setProjectFlag(FILE, 'alpha', { starred: true })
    const r = setProjectFlag(FILE, 'alpha', { starred: false })
    expect(r!.starred).toBe(false)
  })
  it('returns null for an unknown project and does not create it', () => {
    expect(setProjectFlag(FILE, 'nope', { starred: true })).toBeNull()
    expect(listProjects(FILE).nope).toBeUndefined()
  })
})

describe('reorderProjects', () => {
  beforeEach(() => {
    writeRaw({
      alpha: { path: '/a', starred: false, hidden: false, order: 0 },
      beta: { path: '/b', starred: false, hidden: false, order: 1 },
      gamma: { path: '/c', starred: false, hidden: false, order: 2 },
    })
  })
  it('reassigns order to match the array', () => {
    expect(reorderProjects(FILE, ['gamma', 'alpha', 'beta'])).toEqual({ ok: true })
    const p = listProjects(FILE)
    expect(p.gamma!.order).toBe(0)
    expect(p.alpha!.order).toBe(1)
    expect(p.beta!.order).toBe(2)
  })
  it('rejects an unknown name and does not write', () => {
    const before = readRaw()
    const r = reorderProjects(FILE, ['gamma', 'nope'])
    expect(r).toEqual({ ok: false, unknown: ['nope'] })
    expect(readRaw()).toEqual(before)
  })
  it('appends omitted known projects after the listed ones in prior relative order', () => {
    // Only reorder gamma; alpha (order 0) and beta (order 1) are omitted.
    expect(reorderProjects(FILE, ['gamma'])).toEqual({ ok: true })
    const p = listProjects(FILE)
    expect(p.gamma!.order).toBe(0)
    expect(p.alpha!.order).toBe(1)
    expect(p.beta!.order).toBe(2)
  })
})
