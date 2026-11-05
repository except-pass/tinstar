import { describe, expect, it } from 'vitest'
import { MAX_WORKER_LINK_CHARS, parseWorkerLinks, readWorkerLinks, WORKER_LINK_SCHEMA } from '../workerLinks'

const worker = { fm_home: '/farm/fm-home', task_id: 'worker', first_observed_spawn_gen: 'gen-1' }
const payload = (tasks: unknown = [worker], extra = {}) => JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks, ...extra })
const rich = (chunks: unknown[]) => ({ type: 'rich_text', rich_text: chunks.map(content => ({ text: { content } })) })

describe('versioned Notion worker declarations', () => {
  it('accepts multiple exact worker identities and explicitly empty declarations', () => {
    const tasks = [worker, { ...worker, task_id: 'helper' }, { ...worker, fm_home: '/farm/other' }]
    expect(parseWorkerLinks(payload(tasks))).toEqual({ status: 'valid', tasks })
    expect(parseWorkerLinks(payload([]))).toEqual({ status: 'valid', tasks: [] })
  })
  it('concatenates every rich-text item in order using read and write response shapes', () => {
    const value = payload()
    expect(readWorkerLinks({ type: 'rich_text', rich_text: [
      { plain_text: value.slice(0, 20), text: { content: 'ignored fallback' } },
      { text: { content: value.slice(20, 50) } }, { plain_text: value.slice(50) },
    ] })).toEqual(parseWorkerLinks(value))
  })
  it.each([
    ['malformed', '{'], ['unknown version', JSON.stringify({ schema: 'next', tasks: [] })],
    ['non-object', 'null'], ['non-array tasks', payload({})], ['extra root field', payload([], { Owner: 'Firstmate' })],
    ['non-object task', payload([null])], ['missing home', payload([{ task_id: 'worker', first_observed_spawn_gen: 'g' }])],
    ['missing task', payload([{ fm_home: '/farm', first_observed_spawn_gen: 'g' }])],
    ['missing generation', payload([{ fm_home: '/farm', task_id: 'w' }])],
    ['extra worker attribute', payload([{ ...worker, machine: 'hulk' }])],
    ['duplicate worker', payload([worker, worker])],
    ['duplicate worker with different generation', payload([worker, { ...worker, first_observed_spawn_gen: 'g2' }])],
    ['duplicate JSON key', '{"schema":"tinstar.fm-links.v1","tasks":[],"tasks":[]}'],
    ['escaped duplicate JSON key', '{"schema":"tinstar.fm-links.v1","tasks":[{"fm_home":"/farm","fm_ho\\u006de":"/other","task_id":"w","first_observed_spawn_gen":"g"}]}'],
    ...['', 'relative', '/farm/', '/farm//home', '/farm/../home', '/farm/./home', ' /farm', '/farm\u0000'].map(fm_home => ['ambiguous home', payload([{ ...worker, fm_home }])]),
    ...['', ' worker', 'worker ', 'worker\n', null, ['worker']].map(task_id => ['ambiguous task', payload([{ ...worker, task_id }])]),
    ...['', ' gen', null, 1].map(first_observed_spawn_gen => ['ambiguous generation', payload([{ ...worker, first_observed_spawn_gen }])]),
    ['oversized', ' '.repeat(MAX_WORKER_LINK_CHARS + 1)],
  ])('rejects %s', (_name, value) => {
    expect(parseWorkerLinks(value)).toMatchObject({ status: 'invalid', reason: expect.any(String) })
  })
  it('bounds total length while accepting the exact limit across 100 items', () => {
    const value = payload([]).padEnd(MAX_WORKER_LINK_CHARS, ' ')
    const chunks = Array.from({ length: 100 }, (_, i) => value.slice(i * 2000, (i + 1) * 2000))
    expect(parseWorkerLinks(value)).toEqual({ status: 'valid', tasks: [] })
    expect(readWorkerLinks(rich(chunks))).toEqual({ status: 'valid', tasks: [] })
    expect(readWorkerLinks(rich([...chunks, ' ']))).toMatchObject({ status: 'invalid' })
    expect(readWorkerLinks(rich([' '.repeat(2001)]))).toMatchObject({ status: 'invalid' })
  })
  it.each([undefined, null, {}, { type: 'title', title: [] }, { type: 'rich_text' },
    { ...rich(['{}']), has_more: true }, rich([null]), { type: 'rich_text', rich_text: [{ plain_text: 123 }] },
  ])('keeps missing, unreadable and truncated properties unknown (%j)', value => {
    expect(readWorkerLinks(value)).toMatchObject({ status: 'unknown' })
  })
  it('treats an empty or whitespace-only property as unknown and unlinked', () => {
    const blank = { status: 'unknown', reason: 'Blank property is unlinked' }
    expect(readWorkerLinks(rich([]))).toEqual(blank)
    expect(readWorkerLinks({ type: 'rich_text', rich_text: [] })).toEqual(blank)
    expect(readWorkerLinks(rich(['', ' \n\t']))).toEqual(blank)
    expect(readWorkerLinks({ type: 'rich_text', rich_text: [{ plain_text: '  ' }, { text: { content: '\n' } }] })).toEqual(blank)
    expect(readWorkerLinks(rich([payload([])]))).toEqual({ status: 'valid', tasks: [] })
    expect(readWorkerLinks(rich(['{']))).toMatchObject({ status: 'invalid', reason: 'Malformed JSON' })
    expect(parseWorkerLinks(undefined)).toMatchObject({ status: 'unknown', reason: 'Property is missing or unreadable' })
  })
})
