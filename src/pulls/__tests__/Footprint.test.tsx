// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useElementAsk } from '../../ask/useElementAsk'
import { Footprint } from '../Footprint'
import type { PullFootprint } from '../../shared/pullFootprint'
afterEach(cleanup)
it('filters actual files by category, retains zero-line renames, and offers a non-generated denominator', () => {
  const data: PullFootprint = { head: 'a'.repeat(40), baseHead: 'b'.repeat(40), complete: false, freshness: 'fresh', observedAt: '2026-11-08T00:00:00Z', expectedFiles: 4, error: 'Page failed; observed files only', files: [
    { filename: 'package-lock.json', previousFilename: null, status: 'modified', additions: 9997, deletions: 0, changes: 9997, category: 'Generated & Dependencies', url: 'https://github.com/owner/repo/pull/1/files#diff-1' },
    { filename: 'src/code.ts', previousFilename: null, status: 'modified', additions: 2, deletions: 1, changes: 3, category: 'Code', url: 'https://github.com/owner/repo/pull/1/files#diff-2' },
    { filename: 'new.bin', previousFilename: 'old.bin', status: 'renamed', additions: 0, deletions: 0, changes: 0, category: 'Other', url: 'https://github.com/owner/repo/pull/1/files#diff-3' },
  ] }
  render(<Footprint data={data} />)
  expect(screen.getByRole('heading', { name: /3 \/ 4 files · Partial/ })).toBeTruthy()
  expect(screen.getByText(/0 line changes/)).toBeTruthy()
  expect(screen.getByText(/renamed from old.bin/)).toBeTruthy()
  const links = screen.getAllByRole('link')
  expect(links[0]?.textContent).toBe('package-lock.json')
  fireEvent.click(screen.getByRole('button', { name: /Code: 0.0%/ }))
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link').getAttribute('href')).toContain('/files#diff-2')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Exclude generated & dependencies' }))
  expect(screen.getByRole('button', { name: /Code: 100.0%/ })).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'package-lock.json' })).toBeNull()
  expect(screen.getByRole('link', { name: 'new.bin' })).toBeTruthy()
})


it('captures category and filename context without blocking category filtering', () => {
  const open = vi.fn()
  const data: PullFootprint = { head: 'a'.repeat(40), baseHead: 'b'.repeat(40), complete: true, freshness: 'fresh', observedAt: '2026-11-08T00:00:00Z', expectedFiles: 1, error: null, files: [
    { filename: 'src/code.ts', previousFilename: null, status: 'modified', additions: 2, deletions: 1, changes: 3, category: 'Code', url: 'https://github.com/owner/repo/pull/1/files#diff-2' },
  ] }
  function Harness() {
    const root = useRef<HTMLDivElement>(null)
    const affordance = useElementAsk(root, { target: { kind: 'pull', id: 'owner/repo#1' } }, open)
    return <><div ref={root}><Footprint data={data} /></div>{affordance}</>
  }
  render(<Harness />)
  const category = screen.getByRole('button', { name: /Code: 100.0%/ })
  fireEvent.contextMenu(category)
  expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ element: expect.objectContaining({ label: 'File category', value: category.textContent }) }))
  fireEvent.click(category)
  expect(category).toHaveAttribute('aria-pressed', 'true')
  const filename = screen.getByRole('link', { name: 'src/code.ts' })
  fireEvent.mouseOver(filename)
  expect(screen.queryByRole('button', { name: /^Ask about/ })).toBeNull()
  fireEvent.contextMenu(filename)
  expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ element: expect.objectContaining({ label: 'Filename', value: 'src/code.ts' }) }))
})
