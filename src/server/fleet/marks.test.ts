import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkerMarks, WorkerMarksUnreadable } from './marks'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function marks(): WorkerMarks {
  root = mkdtempSync(join(tmpdir(), 'tinstar-marks-'))
  return new WorkerMarks(root)
}

function file(): string {
  return readFileSync(join(root, 'worker-marks.json'), 'utf8')
}

it('stores a direct mark by home and worker id and leaves a repeat unchanged', async () => {
  const store = marks()
  expect(await store.read()).toEqual([])
  expect(await store.set('/homes/a', 'helm', true)).toBe(true)
  expect(statSync(join(root, 'worker-marks.json')).mode & 0o777).toBe(0o600)
  expect(await store.read()).toEqual([{ home: '/homes/a', id: 'helm' }])
  const written = file()
  expect(await store.set('/homes/a', 'helm', true)).toBe(false)
  expect(file()).toBe(written)
  expect(await store.set('/homes/a', 'helm', false)).toBe(true)
  expect(await store.read()).toEqual([])
})

it('keeps the same worker id direct in one home and managed in another', async () => {
  const store = marks()
  await Promise.all([
    store.set('/homes/a', 'helm', true),
    store.set('/homes/b', 'helm', true),
    store.set('/homes/a', 'keel', true),
  ])
  expect(await store.read()).toEqual([
    { home: '/homes/a', id: 'helm' },
    { home: '/homes/b', id: 'helm' },
    { home: '/homes/a', id: 'keel' },
  ])
  expect(await store.set('/homes/a', 'helm', false)).toBe(true)
  expect(await store.read()).toEqual([
    { home: '/homes/b', id: 'helm' },
    { home: '/homes/a', id: 'keel' },
  ])
  const reloaded = new WorkerMarks(root)
  expect(await reloaded.read()).toEqual([
    { home: '/homes/b', id: 'helm' },
    { home: '/homes/a', id: 'keel' },
  ])
})

it('does not overwrite a marks file that cannot be parsed', async () => {
  const store = marks()
  writeFileSync(join(root, 'worker-marks.json'), '{', { mode: 0o600 })
  await expect(store.set('/homes/a', 'helm', true)).rejects.toBeInstanceOf(WorkerMarksUnreadable)
  expect(file()).toBe('{')
  await expect(store.read()).rejects.toBeInstanceOf(WorkerMarksUnreadable)
  expect(file()).toBe('{')
})

it('treats a missing direct list as empty and drops blank entries', async () => {
  const store = marks()
  writeFileSync(join(root, 'worker-marks.json'), JSON.stringify({
    keep: 1,
    direct: [{ home: '', id: 'helm' }, { home: '/homes/a', id: 'keel' }, 'nope'],
  }))
  expect(await store.read()).toEqual([{ home: '/homes/a', id: 'keel' }])
  writeFileSync(join(root, 'worker-marks.json'), JSON.stringify({ keep: 1, direct: 'nope' }))
  expect(await store.read()).toEqual([])
  expect(await store.set('/homes/a', 'helm', true)).toBe(true)
  expect(JSON.parse(file())).toEqual({ keep: 1, direct: [{ home: '/homes/a', id: 'helm' }] })
})
