import { describe, it, expect } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const relay = resolve(import.meta.dirname, '../../../bin/tinstar-fm-fixed-pty')
const hasPython = (() => { try { execFileSync('python3', ['-c', '']); return true } catch { return false } })()

const UNITS = ['\x1b[38;5;208m', '█▓▒░', '\x1b[0m', ' café ✦ ', '\x1b]8;;https://example.test\x07', 'link', '\x1b]8;;\x07', '\r\n']
  .map(unit => Buffer.from(unit))
const LINE = Buffer.concat(UNITS)
const BOUNDARIES = new Set(UNITS.reduce<number[]>((acc, unit) => [...acc, acc[acc.length - 1]! + unit.length], [0]).map(n => n % LINE.length))
const REPORT = /\x1b\]7337;(\d+);(\d+)\x07/g

describe.skipIf(!hasPython)('tinstar-fm-fixed-pty size reports', () => {
  it('reports the size while the worker streams, only between whole escape sequences and characters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tinstar-fixed-pty-'))
    try {
      writeFileSync(join(dir, 'tmux'), '#!/bin/sh\necho "120 40"\n')
      chmodSync(join(dir, 'tmux'), 0o755)
      const units = JSON.stringify(UNITS.map(unit => [...unit]))
      writeFileSync(join(dir, 'worker'), `#!/usr/bin/env python3
import os, time
units = [bytes(u) for u in ${units}]
os.system("stty -opost")
end = time.monotonic() + 6
while time.monotonic() < end:
    for unit in units:
        half = max(1, len(unit) // 2)
        os.write(1, unit[:half])
        time.sleep(0.003)
        os.write(1, unit[half:])
    time.sleep(0.03)
`)
      chmodSync(join(dir, 'worker'), 0o755)
      const child = spawn('python3', [relay, join(dir, 'worker'), 'firstmate', '@1', 'fm-a', '120', '40'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'inherit'],
      })
      const chunks: Buffer[] = []
      child.stdout.on('data', chunk => chunks.push(chunk))
      await new Promise(resolve => setTimeout(resolve, 5_500))
      child.kill('SIGTERM')
      await new Promise(resolve => child.on('exit', resolve))
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
      expect(offsets.filter(offset => !BOUNDARIES.has(offset % LINE.length))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
