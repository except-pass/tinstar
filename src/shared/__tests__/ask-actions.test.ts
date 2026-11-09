import { describe, expect, it } from 'vitest'
import { askActionSchema, askSuggestionsSchema } from '../ask-actions'

const close = { id: 'close-done', label: 'Close as Done', instruction: 'Post the #3194 Feed verdict and set the linked Notion card Done' }

describe('Ask recommendations', () => {
  it('accepts contextual structured choices alongside unchanged historical text', () => {
    const legacy = ['Review https://example.test', '<script>alert(1)</script>', '']
    expect(askSuggestionsSchema.parse([...legacy, close])).toEqual([...legacy, close])
    expect(askSuggestionsSchema.parse([])).toEqual([])
    expect(askActionSchema.parse({ ...close, label: ' Close as Done ' }).label).toBe('Close as Done')
  })

  it.each([
    { id: '' }, { id: 'a'.repeat(65) }, { id: '../close' }, { id: 'close.done' }, { id: '-close' }, { id: 'close done' },
    { label: '' }, { label: '   ' }, { label: 'a'.repeat(65) },
    { instruction: '' }, { instruction: 'a'.repeat(2001) },
    { instruction: 'Post the verdict', url: 'https://example.test' },
    { execute: true },
  ])('rejects malformed structured choice %j', change => {
    expect(askActionSchema.safeParse({ ...close, ...change }).success).toBe(false)
  })

  it.each([
    'Open https://example.test', 'Open HTTP://example.test', 'Open //example.test/path', 'Open //localhost/path',
    'Open www.example.test', 'Open github.com/team/repo', 'Open [evidence](relative/path)',
    'javascript:alert(1)', 'data:text/html,hello', 'file:/etc/passwd', 'mailto:owner@example.test',
    '`run this`', '```sh echo unsafe```', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
    '$(touch /tmp/example)', '${SECRET}', 'Run first && run second', 'Run first || run second', 'Run first | run second',
    'const value = 1', 'eval (source)', 'print("unsafe")', 'fetch("payload")', 'os.system("unsafe")',
    '#!/bin/sh', 'bash -c unsafe', 'python3 -c unsafe', 'curl example.test', 'rm -rf /',
    'Post\nthen close', 'Post\rthen close', 'Post\tthen close', '\nPost the verdict', 'Post the verdict\n',
    'Post\u0000then close', 'Post\u007fthen close', 'Post\u2028then close',
  ])('rejects explicit links or executable containers: %s', instruction => {
    expect(askActionSchema.safeParse({ ...close, instruction }).success).toBe(false)
    expect(askActionSchema.safeParse({ ...close, label: instruction }).success).toBe(false)
  })

  it('accepts bounded prose and identifiers without changing the meaning', () => {
    expect(askActionSchema.parse({ id: 'A_1-close', label: 'Keep open', instruction: 'Retain card until a real DEV stall exhibits Feed recovery.' }).instruction).toContain('real DEV stall')
    expect(askActionSchema.safeParse({ id: 'x'.repeat(64), label: 'x'.repeat(64), instruction: 'x'.repeat(2000) }).success).toBe(true)
    expect(askActionSchema.safeParse({ ...close, instruction: "Recheck the PR head (including CI) before changing the card's status." }).success).toBe(true)
  })

  it('bounds the mixed array and rejects ambiguous duplicate action IDs', () => {
    expect(askSuggestionsSchema.safeParse(Array(11).fill('legacy')).success).toBe(false)
    expect(askSuggestionsSchema.safeParse(['x'.repeat(2001)]).success).toBe(false)
    expect(askSuggestionsSchema.safeParse([close, { ...close, label: 'Other consequence' }]).success).toBe(false)
    expect(askSuggestionsSchema.safeParse(Array(10).fill('legacy')).success).toBe(true)
    expect(askSuggestionsSchema.safeParse([close, 'close-done', { ...close, id: 'other' }]).success).toBe(true)
    expect(askSuggestionsSchema.safeParse([{ label: 'No retained ID', instruction: 'Close card' }]).success).toBe(false)
  })
})
