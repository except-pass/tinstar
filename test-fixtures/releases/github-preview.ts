import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideStaticServe } from '../../src/server/staticServe'
import { GithubReleaseReader } from '../../src/server/releases/github'
import { releaseAssociations } from '../../src/shared/releases'
import { fixtureScene } from '../reconciliation/scenes'
import { nativeFixtureRead, nativeRepo, nativeTime } from './github-native'

/** Private fixture server: real shipped client and release read model, no live
 * backend/config/home or external requests. Port stays in the preview range. */
export async function githubReleasePreview(port = 5293) {
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
  const card = scene.cards[0]!
  card.source.properties.Link = { id: 'link', type: 'url', hasMore: false, value: `https://github.com/${nativeRepo}/pull/3267` }
  card.source.properties.Status!.value = 'Waiting for Prod Release'
  card.source.properties.Name!.value = 'Improve command delivery'
  const data = releaseAssociations(scene)
  const reader = new GithubReleaseReader(nativeFixtureRead(), () => Date.parse(nativeTime))
  const native = await reader.get(data)
  Object.assign(data, { releases: native.releases, releaseSource: { status: native.status, observedAt: native.observedAt, warnings: native.warnings } })
  const client = resolve('dist/client')
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    if (path.startsWith('/api/')) {
      const payload = path === '/api/quota' ? { providers: [], checkedAt: null, fetchedAt: null, commandError: null }
        : { ok: true, data: path === '/api/releases' ? data : path === '/api/reconciliation/scene' ? scene : path === '/api/fleet' ? { ready: true, workers: [], attention: [], errors: [] } : path === '/api/fleet/messages' ? [] : {} }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); return
    }
    const decision = decideStaticServe(path, client, existsSync)
    if (decision.kind === 'file') { res.writeHead(200, { 'Content-Type': decision.mime }); res.end(readFileSync(decision.filePath)) }
    else if (decision.kind === 'spa') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(readFileSync(decision.indexPath)) }
    else { res.writeHead(404); res.end() }
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return { server, base: `http://127.0.0.1:${port}`, data }
}
