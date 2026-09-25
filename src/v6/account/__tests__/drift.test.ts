import { describe, expect, it } from 'vitest'
import { parseNeedsYouItem } from '../../contract/needsyou'
import {
  acknowledgeTask,
  applySample,
  driftItemId,
  driftReached,
  driftWire,
  rebudgetTask,
  type SampleInput,
  type ScheduleTask,
} from '../drift'

const at = '2026-09-25T12:00:00.000Z'

function sample(over: Partial<SampleInput> = {}): SampleInput {
  return {
    taskId: 'task-1',
    plannedMs: 10_000,
    elapsedMs: 10_000,
    retryCount: 0,
    activity: 'writing',
    lastProgress: { unknown: true },
    evidence: '',
    explanation: '',
    at,
    ...over,
  }
}

describe('schedule drift', () => {
  it('raises one continuing item at 1.5× and keeps the baseline across retry and acknowledge', () => {
    expect(driftReached({ plannedMs: 10_000, elapsedMs: 14_999 })).toBe(false)
    expect(driftReached({ plannedMs: 10_000, elapsedMs: 15_000 })).toBe(true)

    const first = applySample(undefined, sample())
    expect(driftReached(first)).toBe(false)
    const over = applySample(first, sample({ elapsedMs: 15_000, plannedMs: 1, retryCount: 4, explanation: 'still editing' }))
    expect(over.plannedMs).toBe(10_000)
    expect(over.elapsedMs).toBe(15_000)
    expect(over.retryCount).toBe(4)
    expect(over.startedAt).toBe(at)
    expect(over.explanation).toMatch(/work continues/i)

    const retried = applySample(over, sample({ elapsedMs: 0, retryCount: 5 }))
    expect(retried.elapsedMs).toBe(15_000)
    expect(retried.retryCount).toBe(5)
    expect(retried.plannedMs).toBe(10_000)
    expect(retried.startedAt).toBe(at)

    const acked = acknowledgeTask(retried, at)
    expect(acked.plannedMs).toBe(10_000)
    expect(acked.elapsedMs).toBe(15_000)
    expect(acked.acknowledgedAt).toBe(at)

    const forecast = rebudgetTask(acked, 80_000)
    expect(forecast.plannedMs).toBe(10_000)
    expect(forecast.forecastMs).toBe(80_000)
    expect(forecast.explanation).toMatch(/work continues/i)

    const wire = driftWire(forecast, at, at)
    expect(wire.id).toBe(driftItemId('task-1'))
    const parsed = parseNeedsYouItem(wire)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.executionImpact).toBe('continues')
    expect(parsed.value.payload).toMatchObject({ plannedMs: 10_000, elapsedMs: 15_000, continues: true })
  })

  it('uses a stable id per task', () => {
    const tasks: ScheduleTask[] = [
      applySample(undefined, sample({ taskId: 'alpha' })),
      applySample(undefined, sample({ taskId: 'beta' })),
    ]
    expect(tasks.map(task => driftItemId(task.taskId))).toEqual([
      'schedule-drift:alpha',
      'schedule-drift:beta',
    ])
  })
})
