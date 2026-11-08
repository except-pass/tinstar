import { expect, it, vi } from 'vitest'
import { PullFilesReader } from '../files'
import { fileCategory, footprintTotals, type PullFile } from '../../../shared/pullFootprint'
const head = 'a'.repeat(40), base = 'b'.repeat(40), url = 'https://github.com/owner/repo/pull/1'
const meta = (changed_files: number) => ({ head: { sha: head }, base: { sha: base }, changed_files })
const file = (filename: string) => ({ filename, status: 'modified', additions: 2, deletions: 1, changes: 3 })
it.each([
  ['src/generated/config.test.ts', 'Generated & Dependencies'], ['vendor/lib.cpp', 'Generated & Dependencies'], ['package-lock.json', 'Generated & Dependencies'],
  ['Tests/config.test.ts', 'Tests'], ['test-fixtures/data.json', 'Tests'], ['src/config.spec.ts', 'Tests'], ['docs/config.yaml', 'Docs'],
  ['README.md', 'Docs'], ['.github/workflows/ci.yml', 'Config'], ['vite.config.ts', 'Config'], ['src/main.ts', 'Code'], ['image.png', 'Other'],
  ['CMakeLists.txt', 'Config'], ['src/CMakeLists.txt', 'Config'], ['notes.txt', 'Docs'],
  ['generated/CMakeLists.txt', 'Generated & Dependencies'], ['tests/CMakeLists.txt', 'Tests'], ['docs/CMakeLists.txt', 'Docs'],
])('classifies %s using ordered deterministic rules', (path, category) => { expect(fileCategory(path)).toBe(category) })
it('uses changed lines, preserves zero-line files and exposes handwritten code despite large generated changes', () => {
  const files = [{ ...file('src/main.ts'), category: 'Code' }, { ...file('package-lock.json'), additions: 9997, deletions: 0, category: 'Generated & Dependencies' }, { ...file('image.png'), additions: 0, deletions: 0, category: 'Other' }] as PullFile[]
  expect(footprintTotals(files)).toMatchObject({ total: 10000, handwrittenCode: 3 })
  expect(footprintTotals(files, true)).toMatchObject({ total: 3, handwrittenCode: 3, categories: expect.arrayContaining([{ category: 'Code', files: 1, lines: 3, percent: 100 }, { category: 'Other', files: 1, lines: 0, percent: 0 }]) })
})
it('paginates files, preserves rename/binary metadata and shares a head-scoped cache', async () => {
  const read = vi.fn(async (path: string) => path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => file(`src/${i}.ts`)) : path.endsWith('page=2') ? [{ ...file('new.bin'), previous_filename: 'old.bin', status: 'renamed', additions: 0, deletions: 0, changes: 0 }] : meta(101))
  const reader = new PullFilesReader(read)
  const [one, two] = await Promise.all([reader.get(url, head), reader.get(url, head)])
  expect(one).toEqual(two)
  expect(one).toMatchObject({ complete: true, expectedFiles: 101, head, baseHead: base })
  expect(one.files).toHaveLength(101)
  expect(one.files.at(-1)).toMatchObject({ filename: 'new.bin', previousFilename: 'old.bin', additions: 0, url: expect.stringMatching(/\/files#diff-[a-f0-9]{64}$/) })
  await reader.get(url, head)
  expect(read).toHaveBeenCalledTimes(4)
  await expect(reader.get(url, 'c'.repeat(40))).rejects.toThrow('PR head changed')
})
it('labels page failures and the provider file limit partial', async () => {
  const read = vi.fn(async (path: string) => {
    if (path.endsWith('page=2')) throw new Error('No access')
    return path.includes('/files?') ? Array.from({ length: 100 }, (_, i) => file(`src/${i}.ts`)) : meta(101)
  })
  expect(await new PullFilesReader(read).get(url, head)).toMatchObject({ complete: false, error: 'No access', files: expect.any(Array) })
  const limited = new PullFilesReader(async path => path.includes('/files?') ? Array.from({ length: 100 }, (_, i) => file(`src/${path.split('page=').at(-1)}-${i}.ts`)) : meta(3001))
  const result = await limited.get(url, head)
  expect(result.files).toHaveLength(3000)
  expect(result).toMatchObject({ complete: false, error: expect.stringContaining('3,000') })
})
it.each(['head', 'base'])('rejects a %s change during pagination and permits retry', async side => {
  let calls = 0
  const read = vi.fn(async (path: string) => path.includes('/files?') ? [file('src/a.ts')] : ++calls === 1 ? meta(1) : { ...meta(1), [side]: { sha: 'c'.repeat(40) } })
  await expect(new PullFilesReader(read).get(url, head)).rejects.toThrow('PR diff changed')
})
it('retains same-head/base cached files explicitly stale on failed refresh and retries after expiry', async () => {
  let now = 0, failed = false
  const reader = new PullFilesReader(async path => {
    if (!path.includes('/files?')) return meta(1)
    if (failed) throw new Error('Rate limit')
    return [file('src/a.ts')]
  }, () => now)
  await reader.get(url, head)
  failed = true; now += 121000
  expect(await reader.get(url, head)).toMatchObject({ complete: false, freshness: 'stale', error: 'Rate limit', files: [expect.objectContaining({ filename: 'src/a.ts' })] })
  failed = false; now += 121000
  expect(await reader.get(url, head)).toMatchObject({ complete: true, freshness: 'fresh' })
})
