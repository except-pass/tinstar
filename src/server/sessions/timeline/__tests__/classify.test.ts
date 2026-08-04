import { describe, it, expect } from 'vitest'
import { classifyCodexCall, classifyClaudeCall } from '../classify'
import { newReaderState, noteEntry, finishState } from '../shared'

describe('classifyCodexCall', () => {
  it('splits a parked approval prompt off from the real runtime (R5)', () => {
    // The case that motivated the feature: an rm -rf whose own output says it
    // ran for 0 seconds, but whose result landed 528 minutes later. All of that
    // was an approval prompt nobody noticed.
    const out = classifyCodexCall(
      0, 31_698, 'exec_command',
      '{"cmd":"rm -rf /tmp/ce-code-review/jobs/x"}',
      'Chunk ID: 038b37\nWall time: 0.0000 seconds\nProcess exited with code 0\n',
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('approval')
    expect(out[0]!.end - out[0]!.start).toBeCloseTo(31_698, 0)
  })

  it('keeps the tail as tool time when the process really ran (R5)', () => {
    const out = classifyCodexCall(
      0, 300, 'exec_command', '{"cmd":"npm test"}',
      'Wall time: 120.0000 seconds\nProcess exited with code 0\n',
    )
    expect(out.map(i => i.kind)).toEqual(['approval', 'tool'])
    expect(out[0]!.end - out[0]!.start).toBeCloseTo(180, 0)
    expect(out[1]!.end - out[1]!.start).toBeCloseTo(120, 0)
  })

  it('does not call a genuinely slow tool an approval', () => {
    const out = classifyCodexCall(
      0, 130, 'exec_command', '{"cmd":"npm test"}',
      'Wall time: 129.0000 seconds\nProcess exited with code 0\n',
    )
    expect(out.map(i => i.kind)).toEqual(['tool'])
  })

  it('ignores a sub-minute gap as scheduling noise, not a human', () => {
    const out = classifyCodexCall(
      0, 40, 'exec_command', '{"cmd":"ls"}',
      'Wall time: 0.5000 seconds\nProcess exited with code 0\n',
    )
    expect(out.map(i => i.kind)).toEqual(['tool'])
  })

  it('falls back to the trivial-command heuristic when runtime is unusable (R6)', () => {
    // Script-wrapped exec reports elapsed-including-stall, so subtraction finds
    // nothing to subtract.
    const out = classifyCodexCall(
      0, 27_361, 'exec',
      'const r = await tools.exec_command({ cmd: "rm -rf -- /tmp/ce-code-review/jobs/y" });',
      'Script running with cell ID 21\n',
    )
    expect(out.map(i => i.kind)).toEqual(['approval'])
  })

  it('still catches a stall when the reported runtime includes the stall (R6)', () => {
    // The production shape, verbatim: a script-wrapped rm -rf that sat on an
    // approval prompt for 7.6h and then reported the whole 7.6h as its own
    // "Wall time". The regex matches, so the subtraction path finds nothing —
    // this must not short-circuit past the heuristic.
    const out = classifyCodexCall(
      0, 27_361, 'exec',
      'const r = await tools.exec_command({ cmd: "rm -rf -- /tmp/ce-code-review/jobs/y" });',
      'Script running with cell ID 21\nWall time 27361.5 seconds\nOutput:\n',
    )
    expect(out.map(i => i.kind)).toEqual(['approval'])
  })

  it('does not apply the heuristic to a long non-trivial command', () => {
    const out = classifyCodexCall(
      0, 27_361, 'exec',
      'const r = await tools.exec_command({ cmd: "npm run build" });',
      'Script running with cell ID 21\n',
    )
    expect(out.map(i => i.kind)).toEqual(['tool'])
  })

  it('does not apply the heuristic to a short trivial command', () => {
    const out = classifyCodexCall(
      0, 12, 'exec_command', '{"cmd":"rm -rf /tmp/x"}', 'no wall time here',
    )
    expect(out.map(i => i.kind)).toEqual(['tool'])
  })

  it('classifies sub-agent polling as its own kind', () => {
    const out = classifyCodexCall(0, 60, 'wait_agent', '{"timeout_ms":60000}', 'ok')
    expect(out.map(i => i.kind)).toEqual(['subagent'])
  })

  it('classifies request_user_input as a question (R7)', () => {
    const out = classifyCodexCall(0, 5, 'request_user_input', '{}', 'ok')
    expect(out.map(i => i.kind)).toEqual(['question'])
  })
})

describe('classifyClaudeCall', () => {
  it('measures AskUserQuestion as question time (R7)', () => {
    const i = classifyClaudeCall(0, 240, 'AskUserQuestion', '{}', '', false)
    expect(i.kind).toBe('question')
    expect(i.end - i.start).toBe(240)
  })

  it('measures ExitPlanMode as question time (R7)', () => {
    expect(classifyClaudeCall(0, 30, 'ExitPlanMode', '{}', '', false).kind).toBe('question')
  })

  it('classifies a rejected permission as approval (R8)', () => {
    const i = classifyClaudeCall(
      0, 90, 'Bash', '{"command":"rm -rf /"}',
      "The user doesn't want to proceed with this tool use. The tool use was rejected", false,
    )
    expect(i.kind).toBe('approval')
    expect(i.name).toContain('rejected')
  })

  it('treats an ordinary tool as tool time', () => {
    expect(classifyClaudeCall(0, 3, 'Read', '{}', 'file contents', false).kind).toBe('tool')
  })

  it('treats an errored tool as tool time — failures are marks, not bands', () => {
    expect(classifyClaudeCall(0, 3, 'Bash', '{}', 'boom', true).kind).toBe('tool')
  })
})

describe('unresolved calls (R4)', () => {
  const feed = (times: number[], callStart: number) => {
    const st = newReaderState()
    for (const t of times) {
      noteEntry(st, t)
      if (t === callStart) st.pending.set('c1', { start: t, name: 'exec', args: '{}' })
    }
    return st
  }

  it('closes a call with no result at the next logged entry, not at now (R4)', () => {
    // Codex drops the output line when a call is interrupted. Stretching such a
    // call to "now" painted a 34.9-hour phantom band over genuine work.
    const out = finishState(feed([50, 100, 150, 900], 100), 100_000)
    const band = out.intervals.find(i => i.name.includes('no result'))!
    expect(band).toBeDefined()
    expect(band.end).toBe(150)
    expect(band.kind).toBe('tool')
  })

  it('treats a call with nothing after it as still in flight', () => {
    const out = finishState(feed([50, 900], 900), 1_000)
    const band = out.intervals.find(i => i.name === 'exec')!
    expect(band.end).toBe(1_000)
  })

  it('adds nothing when no calls are pending', () => {
    const st = newReaderState()
    for (const t of [1, 2, 3]) noteEntry(st, t)
    expect(finishState(st, 10).intervals.filter(i => i.kind === 'tool')).toEqual([])
  })
})

describe('command-word matching (regression: substring matching)', () => {
  const long = (cmd: string) => classifyCodexCall(0, 1200, 'exec', JSON.stringify({ cmd }), 'no wall time').map(i => i.kind)

  it('does not read `docker run --rm` as an approval stall', () => {
    // `--rm` satisfies a \brm\b word boundary; matching the whole arg blob
    // painted a 20-minute container run red.
    expect(long('docker run --rm myimage')).toEqual(['tool'])
  })

  it('does not read a path containing rm as an approval stall', () => {
    expect(long('pytest tests/warm-rm-cache')).toEqual(['tool'])
  })

  it('does not read `git push` as an approval stall', () => {
    // Pushing a large repo legitimately takes minutes.
    expect(long('git push origin main')).toEqual(['tool'])
  })

  it('still catches a real trivial-command stall', () => {
    expect(long('rm -rf /tmp/ce-code-review/jobs/x')).toEqual(['approval'])
  })

  it('sees through a shell wrapper and leading env assignments', () => {
    expect(long('bash -lc "rm -rf /tmp/x"')).toEqual(['approval'])
    expect(long('FOO=1 BAR=2 rm -rf /tmp/x')).toEqual(['approval'])
    expect(long('/usr/bin/rm -rf /tmp/x')).toEqual(['approval'])
  })

  it('under-reports rather than inventing: a long `npm publish` reads as tool time', () => {
    // Deliberate. A command that CAN run long is indistinguishable from one
    // that did; claiming a stall would tell the user they are the blocker.
    expect(long('npm publish')).toEqual(['tool'])
  })
})

describe('rejection detection (regression: substring matching)', () => {
  it('does not treat output that merely QUOTES the marker as a rejection', () => {
    // A grep over this repo returns this exact string — classify.ts contains it.
    const grepOutput = "classify.ts:24:  const REJECT_OPENERS = [\"the user doesn't want to proceed\"]"
    expect(classifyClaudeCall(0, 2, 'Grep', '{}', grepOutput, false).kind).toBe('tool')
  })

  it('still detects a genuine rejection notice', () => {
    const real = "The user doesn't want to proceed with this tool use. The tool use was rejected."
    expect(classifyClaudeCall(0, 90, 'Bash', '{}', real, false).kind).toBe('approval')
  })

  it('tolerates leading whitespace on a genuine rejection', () => {
    expect(classifyClaudeCall(0, 90, 'Bash', '{}', '\n  The user rejected this edit.', false).kind).toBe('approval')
  })
})
