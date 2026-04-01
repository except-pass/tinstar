import { describe, it, expect } from 'vitest'
import { interpolateTemplate } from '../interpolate'

describe('interpolateTemplate', () => {
  it('interpolates task variable', () => {
    const template = 'Review bug {{task}}'
    const vars = { task: 'JIRA-123' }
    expect(interpolateTemplate(template, vars)).toBe('Review bug JIRA-123')
  })

  it('interpolates multiple variables', () => {
    const template = 'Session {{sessionId}} working on {{task}}'
    const vars = { sessionId: 'worker-abc', task: 'JIRA-456' }
    expect(interpolateTemplate(template, vars)).toBe('Session worker-abc working on JIRA-456')
  })

  it('leaves unknown variables as-is', () => {
    const template = 'Value: {{unknown}}'
    const vars = { task: 'test' }
    expect(interpolateTemplate(template, vars)).toBe('Value: {{unknown}}')
  })

  it('handles empty template', () => {
    expect(interpolateTemplate('', { task: 'test' })).toBe('')
  })

  it('handles undefined template', () => {
    expect(interpolateTemplate(undefined, { task: 'test' })).toBeUndefined()
  })
})
