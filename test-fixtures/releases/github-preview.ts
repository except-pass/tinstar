import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decideStaticServe } from '../../src/server/staticServe'
import { GithubReleaseReader } from '../../src/server/releases/github'
import { ReleasesApi } from '../../src/server/releases/routes'
import { ReleasePullReader } from '../../src/server/releases/pulls'
import { fixtureScene } from '../reconciliation/scenes'
import { nativeFixtureRead, nativeHead, nativeRepo, nativeTime } from './github-native'
import { githubJson } from '../../src/server/pulls/github'

/** Private server with the shipped client and real Releases HTTP display path.
 * The real-data option uses read-only GitHub, an empty isolated association scene
 * and temporary config. No live backend, home or production configuration. */
export async function githubReleasePreview(port = 5293, real = false) {
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
  if (real) { scene.cards = []; scene.claims = [] }
  else {
    const card = scene.cards[0]!
    card.source.properties.Link = { id: 'link', type: 'url', hasMore: false, value: `https://github.com/${nativeRepo}/pull/3267` }
    card.source.properties.Status!.value = 'Waiting for Prod Release'
    card.source.properties.Name!.value = 'Improve command delivery'
  }
  const reader = new GithubReleaseReader(real ? githubJson : nativeFixtureRead(), real ? Date.now : () => Date.parse(nativeTime))
  const root = await mkdtemp(join(tmpdir(), 'tinstar-release-preview-'))
  const api = new ReleasesApi({ scene: async () => scene }, root, new ReleasePullReader(async () => ({ title: 'Improve command delivery', state: 'closed', merged: true, merged_at: nativeTime, merge_commit_sha: nativeHead })), undefined, reader)
  const data = await api.read()
  const client = resolve('dist/client')
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    if (path === '/api/releases') { void api.handle(req, res); return }
    if (path.startsWith('/api/')) {
      const payload = path === '/api/quota' ? { providers: [], checkedAt: null, fetchedAt: null, commandError: null }
        : { ok: true, data: path === '/api/reconciliation/scene' ? scene : path === '/api/fleet' ? { ready: true, workers: [], attention: [], errors: [] } : path === '/api/fleet/messages' ? [] : {} }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); return
    }
    const decision = decideStaticServe(path, client, existsSync)
    if (decision.kind === 'file') { res.writeHead(200, { 'Content-Type': decision.mime }); res.end(readFileSync(decision.filePath)) }
    else if (decision.kind === 'spa') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(readFileSync(decision.indexPath)) }
    else { res.writeHead(404); res.end() }
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return { server, base: `http://127.0.0.1:${port}`, data, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true })
  } }
}
