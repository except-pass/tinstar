import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  versions: new Map<string, bigint>(),
  script: 'staging script',
  directory: false,
  stages: 0,
  failStage: false,
  stampsDuringStaging: [] as boolean[],
}))

vi.mock('node:fs', () => ({
  readFileSync: () => state.script,
  statSync: (path: string) => {
    if (path.endsWith('tinstar-shared-action-runtime')) {
      if (!state.directory) throw new Error('ENOENT')
      return { isDirectory: () => true }
    }
    return { size: 10n, mtimeNs: state.versions.get(path) ?? 1n, ctimeNs: 1n, ino: 1n }
  },
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    if (!state.files.has(path)) throw new Error('ENOENT')
    return state.files.get(path)
  },
  writeFile: async (path: string, data: string) => { state.files.set(path, data) },
  rm: async (path: string) => {
    if (path.endsWith('.stamp')) state.files.delete(path)
    else state.directory = false
  },
  unlink: async (path: string) => { state.files.delete(path) },
  open: async (path: string) => {
    if (state.files.has(path)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    state.files.set(path, '')
    return {
      writeFile: async (data: string) => { state.files.set(path, data) },
      close: async () => {},
    }
  },
}))

vi.mock('node:child_process', () => ({
  execFileSync: (command: string) => {
    if (command === '/usr/bin/ldd') return 'libc => /lib/libc.so (0x123)\n/lib/ld-linux.so (0x456)'
    state.stages++
    state.directory = true
    state.stampsDuringStaging.push([...state.files.keys()].some(path => path.endsWith('.stamp')))
    if (state.failStage) throw new Error('Copy failed')
    return ''
  },
}))

import { stageTestRuntime } from './runtimeFixture'

beforeEach(() => {
  state.files.clear()
  state.versions.clear()
  state.script = 'staging script'
  state.directory = false
  state.stages = 0
  state.failStage = false
  state.stampsDuringStaging = []
})

it('shares an unchanged runtime across repeated callers', async () => {
  const runtime = await stageTestRuntime()
  expect(await stageTestRuntime()).toBe(runtime)
  expect(state.stages).toBe(1)
})

it('restages when the staging script changes', async () => {
  await stageTestRuntime()
  state.script = 'updated staging script'
  await stageTestRuntime()
  expect(state.stages).toBe(2)
  expect(state.stampsDuringStaging).toEqual([false, false])
})

it('leaves a failed partial copy unstamped and retries staging on the next call', async () => {
  await stageTestRuntime()
  state.directory = false
  state.failStage = true
  await expect(stageTestRuntime()).rejects.toThrow('Copy failed')
  expect(state.directory).toBe(true)
  expect(state.files.has(join(tmpdir(), 'tinstar-shared-action-runtime.stamp'))).toBe(false)
  state.failStage = false
  await stageTestRuntime()
  expect(state.stages).toBe(3)
  expect(state.stampsDuringStaging).toEqual([false, false, false])
  expect(state.files.has(join(tmpdir(), 'tinstar-shared-action-runtime.stamp'))).toBe(true)
})

it.each([process.execPath, '/usr/bin/prlimit', '/lib/libc.so', '/lib/ld-linux.so'])(
  'restages when the tool input %s changes', async path => {
    await stageTestRuntime()
    state.versions.set(path, 2n)
    await stageTestRuntime()
    expect(state.stages).toBe(2)
  },
)

it('recreates a missing runtime even when its stamp remains', async () => {
  await stageTestRuntime()
  expect(state.files.has(join(tmpdir(), 'tinstar-shared-action-runtime.stamp'))).toBe(true)
  state.directory = false
  await stageTestRuntime()
  expect(state.directory).toBe(true)
  expect(state.stages).toBe(2)
  expect(state.stampsDuringStaging).toEqual([false, false])
})
