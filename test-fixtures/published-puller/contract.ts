import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { publicAsk } from '../../src/shared/ask'
import latest from './latest.json'

const exec = promisify(execFile)
const fixtureRoot = fileURLToPath(new URL('.', import.meta.url))

export async function publishedPullerContract(options: {
  root: string; base: string; token: string
  create: (question: string) => Promise<string>
  list: () => Promise<ReturnType<typeof publicAsk>[]>
  work: () => Promise<{ pending: unknown[]; tracked: unknown[] }>
  reload?: () => void
}) {
  const { root, base, token, create, list, work, reload } = options
  // This pin prevents accidentally testing an edited/current client instead of
  // the bytes installed on owners' Macs. Bump it only from a released package.
  const puller = join(fixtureRoot, latest.version, 'ask-puller.py')
  const digest = createHash('sha256').update(await readFile(puller)).digest('hex')
  assert.equal(digest, latest.sha256, `Published ${latest.version} puller fixture changed`)

  const questions = ['Malformed structured answer', 'Independent answer', 'Capture failure', 'Wake failure']
  const ids = []
  for (const question of questions) ids.push(await create(question))
  const home = join(root, 'published-puller-home')
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  const python = (await exec('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim()
  const inbox = join(bin, 'fm-inbox.sh')
  await copyFile(join(fixtureRoot, 'fm-inbox.py'), inbox)
  // An absolute interpreter and private PATH keep real operator tools out.
  await writeFile(inbox, (await readFile(inbox, 'utf8')).replace('#!/usr/bin/env python3', `#!${python}`))
  await chmod(inbox, 0o700)
  const clavis = join(bin, 'clavis')
  await writeFile(clavis, `#!${python}
import json, pathlib, sys
assert sys.argv[1:] == ['get', 'ci.ask-bridge']
print(json.loads(pathlib.Path(__file__).with_name('credential.json').read_text()))
`)
  await chmod(clavis, 0o700)
  await writeFile(join(bin, 'credential.json'), JSON.stringify(token), { mode: 0o600 })

  // Reuse the released credential lookup and reconciliation unchanged. Only
  // main's HTTPS-origin CLI check is bypassed for the loopback HTTP test server.
  const driver = `import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('published',sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.pull_once(sys.argv[2],m.read_token('ci.ask-bridge'),pathlib.Path(sys.argv[3]))))`
  const run = async () => JSON.parse((await exec(python, ['-B', '-c', driver, puller, base, home], {
    env: { HOME: home, PATH: bin }, timeout: 30_000,
  })).stdout)
  assert.deepEqual(await run(), { captured: 3, replied: 3, failed: 1, queued: 1 })
  reload?.()
  const rows = await list()
  assert.deepEqual(rows.map(row => [row.request_id, row.status]), ids.map((id, i) => [id, i === 2 ? 'failed' : 'answered']))
  assert.ok(rows[0]!.reply)
  const { degraded, summary, detail, references, suggested_actions } = rows[0]!.reply
  assert.deepEqual({ degraded, summary, detail, references, suggested_actions }, {
    degraded: true, summary: 'Preserved answer', detail: 'Preserved evidence',
    references: [{ label: 'Evidence', url: 'https://example.test' }], suggested_actions: [],
  })
  assert.equal(rows[1]!.reply?.detail, 'Independent reply survives an unrelated malformed answer')
  assert.equal(typeof rows[2]!.error, 'string')
  assert.equal(rows[3]!.error, null)
  assert.deepEqual(await work(), { pending: [], tracked: [] })
  assert.deepEqual(await run(), { captured: 0, replied: 0, failed: 0, queued: 0 })
  return { version: latest.version, sha256: digest, requests: ids.length }
}
