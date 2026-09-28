import { describe, it, expect } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const relay = resolve(import.meta.dirname, '../../../bin/tinstar-fm-fixed-pty')
const hasPython = (() => { try { execFileSync('python3', ['-c', '']); return true } catch { return false } })()

const UNITS = ['\x1b[38;5;208m', '█▓▒░', '\x1b[0m', ' café ✦ ', '\x1b]8;;https://example.test\x07', 'link', '\x1b]8;;\x07', '\r\n']
  .map(unit => Buffer.from(unit))
const LINE = Buffer.concat(UNITS)
const BOUNDARIES = new Set(UNITS.reduce<number[]>((acc, unit) => [...acc, acc[acc.length - 1]! + unit.length], [0]).map(n => n % LINE.length))
const REPORT = /\x1b\]7337;(\d+);(\d+)\x07/g
const QUIET_SECONDS = 0.02
const MAX_DELAY_SECONDS = 0.15
const RELAY_SCHEDULING_SECONDS = 0.1

describe.skipIf(!hasPython)('tinstar-fm-fixed-pty size reports', () => {
  it('reports the size while the worker streams, only between whole escape sequences and characters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tinstar-fixed-pty-'))
    try {
      writeFileSync(join(dir, 'tmux'), `#!/usr/bin/env python3
import os, time
print("120 40")
open(os.environ["TINSTAR_TEST_TIMELINE"], "a").write("due %.6f\\n" % time.monotonic())
`)
      chmodSync(join(dir, 'tmux'), 0o755)
      const units = JSON.stringify(UNITS.map(unit => [...unit]))
      writeFileSync(join(dir, 'worker'), `#!/usr/bin/env python3
import os, termios, time
units = [bytes(u) for u in ${units}]
timeline = open(os.environ["TINSTAR_TEST_TIMELINE"], "a", buffering=1)
os.system("stty -opost")
offset = 0
end = time.monotonic() + 6
while time.monotonic() < end:
    burst = time.monotonic() + 0.06
    while time.monotonic() < burst:
        for unit in units:
            half = max(1, len(unit) // 2)
            before = time.monotonic()
            os.write(1, unit[:half])
            offset += half
            termios.tcdrain(1)
            os.write(1, unit[half:])
            timeline.write("split %d %.6f %.6f\\n" % (offset, before, time.monotonic()))
            offset += len(unit) - half
    time.sleep(0.06)
`)
      chmodSync(join(dir, 'worker'), 0o755)
      const child = spawn('python3', [relay, join(dir, 'worker'), 'firstmate', '@1', 'fm-a', '120', '40'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TINSTAR_TEST_TIMELINE: join(dir, 'timeline') },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      const exited = new Promise(resolve => child.on('exit', resolve))
      const chunks: Buffer[] = []
      child.stdout.on('data', chunk => chunks.push(chunk))
      await new Promise(resolve => setTimeout(resolve, 5_500))
      child.kill('SIGTERM')
      await exited
      const output = Buffer.concat(chunks).toString('latin1')
      const offsets: number[] = []
      let stream = 0
      let last = 0
      for (const match of output.matchAll(REPORT)) {
        expect([match[1], match[2]]).toEqual(['120', '40'])
        stream += match.index! - last
        last = match.index! + match[0].length
        offsets.push(stream)
      }
      expect(stream).toBeGreaterThan(LINE.length * 20)
      expect(offsets.length).toBeGreaterThanOrEqual(8)
      const splits = new Map<number, [number, number]>()
      const dues: number[] = []
      for (const [kind, ...values] of readFileSync(join(dir, 'timeline'), 'utf8').split('\n').map(line => line.split(' '))) {
        if (kind === 'split') splits.set(Number(values[0]), [Number(values[1]), Number(values[2])])
        if (kind === 'due') dues.push(Number(values[0]))
      }
      const unexplained = offsets.filter(offset => {
        if (BOUNDARIES.has(offset % LINE.length)) return false
        const split = splits.get(offset)
        if (!split) return true
        const [before, after] = split
        if (after - before >= QUIET_SECONDS) return false
        const latest = after + RELAY_SCHEDULING_SECONDS
        const earlier = dues.filter(time => time <= latest)
        return !earlier.length || Math.max(...earlier) + MAX_DELAY_SECONDS > latest
      })
      expect(unexplained).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
