import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionProbe, recordProbeNames } from '../sessionProbe'

const roots: string[] = []
const root = () => { const path = mkdtempSync(join(tmpdir(), 'tinstar-session-probe-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const headers = { authorization: 'Bearer private-install', 'x-tinstar-caller-authorization': 'Bearer private-caller' }

it('recognizes explicit tokens only for their authenticated caller, forgets on restart and bounds memory', () => {
  const path = root(), probe = new SessionProbe(path)
  const first = probe.call('actor', headers), second = probe.call('actor', headers)
  expect(first.outcome).toBe('issued')
  expect(first.session_token).not.toBe(second.session_token)
  expect(first.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(probe.call('actor', headers, undefined, first.session_token)).toMatchObject({ outcome: 'recognized', matches_known_token: true })
  expect(probe.call('other-actor', headers, undefined, first.session_token).matches_known_token).toBe(false)
  expect(probe.call('actor', { ...headers, 'x-tinstar-caller-authorization': 'rotated' }, undefined, first.session_token).matches_known_token).toBe(false)
  expect(probe.call('actor', headers, undefined, 'invented').matches_known_token).toBe(false)
  expect(new SessionProbe(path).call('actor', headers, undefined, first.session_token).matches_known_token).toBe(false)
  for (let index = 0; index < 256; index++) probe.call('actor', headers)
  expect(probe.call('actor', headers, undefined, first.session_token).matches_known_token).toBe(false)
})

it('records only bounded names with private permissions; never records token or identity values', () => {
  const path = root(), probe = new SessionProbe(path)
  const first = probe.call('private-actor', headers, { 'openai/session': 'private-conversation', 'openai/subject': 'private-user' })
  probe.call('private-actor', headers, { 'openai/session': 'private-conversation' }, first.session_token)
  const file = join(path, 'session-probe-backend.jsonl'), text = readFileSync(file, 'utf8')
  expect(text.trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { header_names: Object.keys(headers).sort(), meta_keys: ['openai/session', 'openai/subject'] },
    { header_names: Object.keys(headers).sort(), meta_keys: ['openai/session'] },
  ])
  for (const secret of ['private-actor', 'private-install', 'private-caller', 'private-conversation', 'private-user', first.session_token!]) expect(text).not.toContain(secret)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const manyKeys = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k'.repeat(256) + i, 'private-value']))
  for (let index = 0; index < 140; index++) recordProbeNames(path, 'backend', {}, manyKeys)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(128)
  expect(JSON.parse(lines[0]!).meta_keys).toHaveLength(64)
  expect(JSON.parse(lines[0]!).meta_keys.every((key: string) => key.length <= 128)).toBe(true)
})

it('reports unavailable diagnostics without breaking token continuity', () => {
  const path = root(), blocked = join(path, 'not-a-directory')
  writeFileSync(blocked, '')
  const probe = new SessionProbe(blocked), first = probe.call('actor', headers)
  expect(first).toMatchObject({ outcome: 'issued', log_recorded: false })
  expect(probe.call('actor', headers, undefined, first.session_token)).toMatchObject({ outcome: 'recognized', log_recorded: false })
})
