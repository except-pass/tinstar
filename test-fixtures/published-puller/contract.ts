import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { publicAsk } from '../../src/shared/ask'
import latest from './latest.json'
import supported from './supported.json'

const exec = promisify(execFile)
const fixtureRoot = fileURLToPath(new URL('.', import.meta.url))

type ContractOptions = {
  root: string; base: string; token: string
  create: (question: string) => Promise<string>
  list: () => Promise<ReturnType<typeof publicAsk>[]>
  work: () => Promise<{ pending: unknown[]; tracked: unknown[] }>
  reload?: () => void
}

export async function publishedPullerContract(options: ContractOptions) {
  assert.ok(supported.some(release => release.version === latest.version && release.sha256 === latest.sha256), 'Latest released puller must remain in CI')
  const proofs = []
  for (const release of supported) proofs.push(await onePublishedPuller(options, release))
  return { version: proofs.map(proof => proof.version).join(', '), sha256: proofs.map(proof => proof.sha256).join(', '), requests: proofs.reduce((sum, proof) => sum + proof.requests, 0) }
}

async function onePublishedPuller(options: ContractOptions, release: { version: string; sha256: string }) {
  const { root, base, token, create, list, work, reload } = options
  // This pin prevents accidentally testing an edited/current client instead of
  // the bytes installed on owners' Macs. Bump it only from a released package.
  const puller = join(fixtureRoot, release.version, 'ask-puller.py')
  const digest = createHash('sha256').update(await readFile(puller)).digest('hex')
  assert.equal(digest, release.sha256, `Published ${release.version} puller fixture changed`)

  const questions = ['Malformed structured answer', 'Independent answer', 'Capture failure', 'Wake failure']
  const ids: string[] = []
  for (const question of questions) ids.push(await create(question))
  const home = join(root, 'published-puller-home-' + release.version)
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
  const rows = (await list()).filter(row => ids.includes(row.request_id))
  assert.deepEqual(rows.map(row => [row.request_id, row.status]), ids.map((id, i) => [id, i === 2 ? 'failed' : 'answered']))
  assert.ok(rows[0]!.reply)
  const { degraded, summary, detail, references, suggested_actions } = rows[0]!.reply
  assert.deepEqual({ degraded, summary, detail, references, suggested_actions }, {
    degraded: true, summary: 'Preserved answer', detail: 'Preserved evidence',
    references: [{ label: 'Evidence', url: 'https://example.test' }], suggested_actions: [],
  })
  const warnings = rows[0]!.reply.rejected_actions
  assert.ok(warnings)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]!.id, 'unsafe')
  assert.match(warnings[0]!.reason, /Backticks/)
  if (release.version !== '6.0.0') {
    const receipts = JSON.parse(await readFile(join(home, 'warning-receipts.json'), 'utf8'))
    assert.deepEqual(Object.values(receipts), [{
      request_id: ids[0], note_id: 'published-' + ids[0], reply_warnings: warnings,
    }])
    const notes = JSON.parse(await readFile(join(home, 'notes.json'), 'utf8'))
    const update = { request_id: ids[0], reply: notes.find((note: { id: string }) => note.id === 'published-' + ids[0]).reply }
    const response = await fetch(base + '/api/ask/bridge', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(update),
    })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data.reply_warnings, warnings)
  }
  assert.equal(rows[1]!.reply?.detail, 'Independent reply survives an unrelated malformed answer')
  assert.equal(typeof rows[2]!.error, 'string')
  assert.equal(rows[3]!.error, null)
  const remaining = await work()
  assert.deepEqual({ pending: remaining.pending, tracked: remaining.tracked }, { pending: [], tracked: [] })
  assert.deepEqual(await run(), { captured: 0, replied: 0, failed: 0, queued: 0 })
  return { version: release.version, sha256: digest, requests: ids.length }
}
