import { describe, it, expect } from 'vitest'
import { parseTaskTags, buildCommitRecord, type CommitHookPayload } from '../commits'

describe('parseTaskTags', () => {
  const defaultRegex = '\\[([A-Z]+-\\d+)\\]'

  it('extracts JIRA-style tags from a commit message', () => {
    expect(parseTaskTags('fix: handle edge case [PROJ-123]', defaultRegex))
      .toEqual(['PROJ-123'])
  })

  it('extracts multiple tags', () => {
    expect(parseTaskTags('[AB-1] and [CD-2] fixes', defaultRegex))
      .toEqual(['AB-1', 'CD-2'])
  })

  it('deduplicates repeated tags', () => {
    expect(parseTaskTags('[AB-1] also [AB-1]', defaultRegex))
      .toEqual(['AB-1'])
  })

  it('returns empty array when no tags match', () => {
    expect(parseTaskTags('just a plain message', defaultRegex))
      .toEqual([])
  })

  it('handles an empty message', () => {
    expect(parseTaskTags('', defaultRegex)).toEqual([])
  })

  it('works with a custom regex', () => {
    expect(parseTaskTags('fixes #42 and #99', '#(\\d+)'))
      .toEqual(['42', '99'])
  })
})

describe('buildCommitRecord', () => {
  const markerRegex = '\\[([A-Z]+-\\d+)\\]'
  const payload: CommitHookPayload = {
    sha: 'abc123',
    repo: 'tinstar',
    branch: 'main',
    message: 'feat: new feature [TASK-1]\n\nSome body text\nmore details',
    authorName: 'Dev',
    authorEmail: 'dev@example.com',
    authorDate: '2026-01-01T00:00:00Z',
    worktreeId: 'wt-1',
  }

  it('splits subject from body', () => {
    const record = buildCommitRecord(payload, 'hook', markerRegex)
    expect(record.subject).toBe('feat: new feature [TASK-1]')
    expect(record.body).toBe('Some body text\nmore details')
  })

  it('preserves all payload fields', () => {
    const record = buildCommitRecord(payload, 'hook', markerRegex)
    expect(record.sha).toBe('abc123')
    expect(record.repo).toBe('tinstar')
    expect(record.branch).toBe('main')
    expect(record.authorName).toBe('Dev')
    expect(record.authorEmail).toBe('dev@example.com')
    expect(record.authorDate).toBe('2026-01-01T00:00:00Z')
    expect(record.worktreeId).toBe('wt-1')
    expect(record.source).toBe('hook')
  })

  it('extracts task tags from the full message', () => {
    const record = buildCommitRecord(payload, 'reconcile', markerRegex)
    expect(record.taskTags).toEqual(['TASK-1'])
  })

  it('sets body to undefined when message has only a subject', () => {
    const single = { ...payload, message: 'one liner' }
    const record = buildCommitRecord(single, 'hook', markerRegex)
    expect(record.subject).toBe('one liner')
    expect(record.body).toBeUndefined()
  })

  it('handles empty body lines (blank line after subject)', () => {
    const withBlank = { ...payload, message: 'subject\n\n' }
    const record = buildCommitRecord(withBlank, 'hook', markerRegex)
    expect(record.subject).toBe('subject')
    expect(record.body).toBeUndefined()
  })

  it('sets observedAt to a recent ISO timestamp', () => {
    const before = Date.now()
    const record = buildCommitRecord(payload, 'hook', markerRegex)
    const after = Date.now()
    const observed = new Date(record.observedAt).getTime()
    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(after)
  })
})
