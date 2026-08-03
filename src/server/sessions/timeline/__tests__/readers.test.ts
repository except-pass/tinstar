import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClaudeTranscript } from '../claude'
import { readCodexTranscript, pickCodexRollout, idleIntervals, buildTurns } from '../codex'

const iso = (sec: number): string => new Date(sec * 1000).toISOString()

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(name: string, lines: unknown[]): string {
  const p = join(dir, name)
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return p
}

describe('readCodexTranscript', () => {
  it('pairs a call to its output and records a non-zero exit as a mark (R12)', () => {
    const p = write('r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w', timestamp: iso(0) } },
      { type: 'event_msg', timestamp: iso(1), payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"git stash --staged"}' } },
      { type: 'response_item', timestamp: iso(5), payload: { type: 'function_call_output', call_id: 'c1', output: 'Wall time: 3.0000 seconds\nProcess exited with code 129\n' } },
      { type: 'event_msg', timestamp: iso(6), payload: { type: 'task_complete' } },
    ])
    const r = readCodexTranscript(p)
    expect(r.t0).toBe(0)
    expect(r.t1).toBe(6)
    expect(r.intervals.filter(i => i.kind === 'tool')).toHaveLength(1)
    expect(r.marks).toHaveLength(1)
    expect(r.marks[0]!.kind).toBe('tool-failed')
    expect(r.marks[0]!.detail).toContain('129')
  })

  it('does not mark a zero exit as a failure', () => {
    const p = write('r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'response_item', timestamp: iso(1), payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' } },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\n' } },
    ])
    expect(readCodexTranscript(p).marks).toHaveLength(0)
  })

  it('records an interrupted sub-agent as a mark', () => {
    const p = write('r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'event_msg', timestamp: iso(3), payload: { type: 'sub_agent_activity', kind: 'interrupted', agent_path: '/root/x' } },
    ])
    const marks = readCodexTranscript(p).marks
    expect(marks).toHaveLength(1)
    expect(marks[0]!.kind).toBe('subagent-interrupted')
  })

  it('ignores the words error and failed in tool output (R12)', () => {
    // ~1,800 outputs in the measured corpus contain these words, nearly all of
    // them grep hits and test summaries. Matching on them buries real failures.
    const p = write('r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'response_item', timestamp: iso(1), payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' } },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call_output', call_id: 'c1', output: '3 tests failed, error in foo.ts\nProcess exited with code 0\n' } },
    ])
    expect(readCodexTranscript(p).marks).toHaveLength(0)
  })

  it('pairs custom_tool_call with custom_tool_call_output', () => {
    const p = write('r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'response_item', timestamp: iso(1), payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'tools.exec_command({cmd:"ls"})' } },
      { type: 'response_item', timestamp: iso(4), payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } },
    ])
    expect(readCodexTranscript(p).intervals.filter(i => i.kind === 'tool')).toHaveLength(1)
  })

  it('skips malformed lines rather than throwing', () => {
    const p = join(dir, 'bad.jsonl')
    writeFileSync(p, '{"type":"session_meta","timestamp":"' + iso(0) + '","payload":{"cwd":"/w"}}\nnot json\n')
    expect(() => readCodexTranscript(p)).not.toThrow()
  })
})

describe('pickCodexRollout', () => {
  it('picks the rollout nearest the session start, not the newest (R19)', () => {
    // A session that spawns sub-agents fills its own cwd with their rollouts,
    // and one of those is usually the most recently written file.
    const picked = pickCodexRollout(1000, [
      { startedSec: 1002, path: '/own.jsonl' },
      { startedSec: 9000, path: '/subagent.jsonl' },
    ])
    expect(picked).toBe('/own.jsonl')
  })

  it('returns null when there are no candidates (R18)', () => {
    expect(pickCodexRollout(1000, [])).toBeNull()
  })
})

describe('idleIntervals', () => {
  it('pairs each human message with the last turn end before it', () => {
    // Pairing with every earlier end manufactures overlapping idle windows and
    // inflates the total past wall clock.
    const out = idleIntervals([1000], [10, 20, 30], 2000)
    expect(out).toHaveLength(1)
    expect(out[0]!.start).toBe(30)
    expect(out[0]!.end).toBe(1000)
  })

  it('treats a trailing turn end with no reply as still waiting on the user', () => {
    const out = idleIntervals([100], [50, 500], 900)
    expect(out.at(-1)!.start).toBe(500)
    expect(out.at(-1)!.end).toBe(900)
  })
})

describe('buildTurns', () => {
  it('marks a turn with no following end as open', () => {
    expect(buildTurns([10, 100], [50], 500)).toEqual([[10, 50, false], [100, 500, true]])
  })
})

describe('readClaudeTranscript', () => {
  it('measures an AskUserQuestion span and marks an is_error result', () => {
    const p = write('c.jsonl', [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }] } },
      { type: 'user', timestamp: iso(61), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'answered' }] } },
      { type: 'assistant', timestamp: iso(62), message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }] } },
      { type: 'user', timestamp: iso(63), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }] } },
    ])
    const r = readClaudeTranscript(p)
    const q = r.intervals.find(i => i.kind === 'question')!
    expect(q.end - q.start).toBe(60)
    expect(r.marks.filter(m => m.kind === 'tool-failed')).toHaveLength(1)
  })

  it('skips sidechain entries so a sub-agent transcript does not double-count', () => {
    const p = write('c.jsonl', [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), isSidechain: true, message: { content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(2), isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'x' }] } },
    ])
    expect(readClaudeTranscript(p).intervals.filter(i => i.kind === 'tool')).toHaveLength(0)
  })

  it('treats a tool_result-bearing user entry as machinery, not a human turn', () => {
    const p = write('c.jsonl', [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    ])
    // one human message → one turn, not two
    expect(readClaudeTranscript(p).turns).toHaveLength(1)
  })
})
