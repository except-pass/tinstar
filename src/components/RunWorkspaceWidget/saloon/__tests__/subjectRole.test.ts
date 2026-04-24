import { describe, it, expect } from 'vitest'
import { classifySubject } from '../subjectRole'

describe('classifySubject', () => {
  const sessionName = 'natsViz'

  it('classifies breakout subjects by prefix', () => {
    expect(classifySubject('tinstar.breakout.abc123', sessionName)).toBe('breakout')
    expect(classifySubject('tinstar.breakout.pair-7af3.design', sessionName)).toBe('breakout')
  })

  it('classifies DM inbox by suffix match against session name', () => {
    expect(classifySubject('tinstar.space.init.epic.task.natsviz', sessionName)).toBe('dm')
    expect(classifySubject('tinstar.space.init.epic.task.someOther', sessionName)).toBe('broadcast')
  })

  it('is case-insensitive for the session-name suffix match', () => {
    expect(classifySubject('tinstar.a.b.c.NatsViz', sessionName)).toBe('dm')
  })

  it('classifies everything else as broadcast', () => {
    expect(classifySubject('tinstar.space.init.epic.task', sessionName)).toBe('broadcast')
    expect(classifySubject('tinstar.system.heartbeat', sessionName)).toBe('broadcast')
  })

  it('prefers breakout over DM when both could match', () => {
    // Hypothetical breakout subject that happens to end with the session name.
    expect(classifySubject('tinstar.breakout.room.natsviz', sessionName)).toBe('breakout')
  })
})
