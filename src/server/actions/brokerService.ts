import { createServer } from 'node:http'
import { chmod, lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { ActionStore } from './store'
import { ActionsApi, actionBody } from './routes'
import { LiveProvider, type BrokerConfig } from './liveProvider'
import { isolatedRunner } from './sandbox'
import { ok, fail } from '../api/envelope'

export function assertBrokerIdentity(config: BrokerConfig, uid = process.getuid?.()) {
  if (uid === undefined || uid === 0 || uid === config.webUid) throw new Error('Broker not provisioned: run as its dedicated non-root identity, distinct from the web server')
  for (const path of [config.custody, config.socket, config.actions, config.runtime]) if (!isAbsolute(path)) throw new Error('Broker paths must be absolute')
}
/** Separate process entrypoint only. The web bundle imports the IPC client, never
 * this provider/key custodian. Unix socket access is granted only to the trusted
 * web identity through the deployment's private group; runner mounts exclude it. */
export function brokerServer(config: BrokerConfig, provider = new LiveProvider(config)) {
  let runnerActive = false
  const api = new ActionsApi(new ActionStore(config.actions), provider.snapshot, config.actions, {
    owners: config.ownerLogins, readJob: (repository, jobId) => provider.job(repository, jobId),
    runtime: {
      run: async (action, target, signal) => {
        // A single source slot prevents independent invocations consuming the
        // host's release-build CPU/memory budget. Selected batches already serialize.
        if (runnerActive) throw new Error('Isolated runner busy; one source slot protects shared host capacity')
        runnerActive = true
        try { return await isolatedRunner(action, target, signal, { runtime: config.runtime }, resource => {
          if (!action.grant.repositories.includes(target.repository) || !action.grant.capabilities.some(capability => ['read', 'review', 'explain', 'conflicts', 'ci.propose'].includes(capability))) throw new Error('Runner read outside installed capability grant')
          return provider.runnerRead(target, resource)
        }) } finally { runnerActive = false }
      },
      perform: async (target, operation, signal) => operation.kind.startsWith('repair.') || operation.kind === 'merge.admin' ? provider.perform(target, operation, signal) :
        { providerRequest: null, actualGitHubWrites: 0, resultingSha: null, verification: 'not-performed', result: `Reader evidence gathered for ${operation.kind}; no repair, merge or deployment performed.` },
    },
  })
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.url === '/reader' && req.method === 'POST') {
          const { path } = z.object({ path: z.string().max(2048) }).strict().parse(await actionBody(req))
          return ok(res, await provider.read(path))
        }
        if (req.url === '/identity' && req.method === 'GET') return ok(res, await provider.identity())
        if (req.url === '/receipt' && req.method === 'POST') {
          const { id } = z.object({ id: z.string().max(100) }).strict().parse(await actionBody(req))
          return ok(res, await api.receipt(id))
        }
        if (await api.handle(req, res)) return
        fail(res, 'NOT_FOUND', 'Unknown typed broker operation')
      } catch (error) {
        const message = error instanceof Error && !('issues' in error) ? error.message : 'Typed broker request refused'
        fail(res, 'CONFLICT', String(provider.redact(message)))
      }
    })()
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000
  server.maxConnections = 8
  return { server, api }
}
export async function listenBroker(config: BrokerConfig, provider?: LiveProvider) {
  assertBrokerIdentity(config)
  // Never unlink an arbitrary preexisting socket/path or take over another lane.
  try { await lstat(config.socket); throw new Error('Broker socket exists; operator must inspect it before starting') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const { server, api } = brokerServer(config, provider)
  const mask = process.umask(0o117)
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve) })
    await chmod(config.socket, 0o660)
  } finally { process.umask(mask) }
  return { server, api }
}
