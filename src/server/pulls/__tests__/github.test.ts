import { expect, it, vi } from 'vitest'
const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
import { githubJson } from '../github'
it('calls gh-axi with GET and decodes multiline JSON without interpreting prose as fields', async () => {
  const data = [{ title: 'quoted "title"\npayload: untrusted', body: 'λ' }]
  exec.mockImplementation((_binary, _args, _options, done) => done(null, { stdout: `payload: ${Buffer.from(JSON.stringify(data)).toString('base64')}\n` }))
  // promisify(execFile) normally returns stdout/stderr; the mock uses that same result shape.
  expect(await githubJson('/repos/owner/repo/pulls')).toEqual(data)
  expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['gh-axi', ['api', 'GET', '/repos/owner/repo/pulls', '--jq', '{payload:(.|tojson|@base64)}', '--full']])
})
it('reports missing binary without echoing credential-bearing stderr', async () => {
  exec.mockImplementation((_binary, _args, _options, done) => done(Object.assign(new Error('secret stderr'), { code: 'ENOENT' })))
  await expect(githubJson('/user')).rejects.toThrow('gh-axi is missing from the server PATH')
})
