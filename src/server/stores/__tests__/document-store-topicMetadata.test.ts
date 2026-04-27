// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentStore } from '../document-store'

const sample = {
  subject: 'tinstar.work-space.x.y.z',
  name: 'Task Room',
  kind: 'broadcast' as const,
  createdAt: '2026-04-27T00:00:00Z',
  createdBy: 'natsViz',
}

describe('DocumentStore.topicMetadata', () => {
  let store: DocumentStore
  beforeEach(() => { store = new DocumentStore() })

  it('upsert + get round-trips', () => {
    store.upsertTopicMetadata(sample.subject, sample)
    expect(store.getTopicMetadata(sample.subject)).toEqual(sample)
  })

  it('getAllTopicMetadata returns all records', () => {
    store.upsertTopicMetadata('a', { ...sample, subject: 'a' })
    store.upsertTopicMetadata('b', { ...sample, subject: 'b' })
    expect(store.getAllTopicMetadata().map(m => m.subject).sort()).toEqual(['a', 'b'])
  })

  it('delete removes the record and emits change', () => {
    let lastChange: unknown = null
    store.changes.on('change', c => { lastChange = c })
    store.upsertTopicMetadata('a', { ...sample, subject: 'a' })
    store.deleteTopicMetadata('a')
    expect(store.getTopicMetadata('a')).toBeUndefined()
    expect(lastChange).toMatchObject({ entity: 'topicMetadata', id: 'a', data: null })
  })

  it('snapshot includes topicMetadata', () => {
    store.upsertTopicMetadata('a', { ...sample, subject: 'a' })
    expect(store.snapshot()).toMatchObject({ topicMetadata: [{ subject: 'a' }] })
  })
})
