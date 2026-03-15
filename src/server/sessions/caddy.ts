import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'

const CONTAINER_NAME = 'tinstar-caddy'
const CADDY_IMAGE = 'caddy:2'
const WAIT_TIMEOUT = 15_000
const WAIT_INTERVAL = 200

export interface CaddyConfig {
  listenPort: number
  adminPort: number
  configDir: string
}

function adminBase(adminPort: number): string {
  return `http://localhost:${adminPort}`
}

function buildInitialConfig(listenPort: number, adminPort: number) {
  return {
    admin: { listen: `localhost:${adminPort}` },
    apps: {
      http: {
        servers: {
          main: {
            listen: [`:${listenPort}`],
            routes: [],
            automatic_https: { disable: true },
          },
        },
      },
    },
  }
}

async function waitForAdmin(adminPort: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < WAIT_TIMEOUT) {
    try {
      const res = await fetch(`${adminBase(adminPort)}/config/`)
      if (res.ok) return
    } catch {
      // not ready
    }
    await new Promise(r => setTimeout(r, WAIT_INTERVAL))
  }
  throw new Error(`Caddy admin API not ready on port ${adminPort} after ${WAIT_TIMEOUT}ms`)
}

async function adminFetch(adminPort: number, method: string, path: string, body?: unknown): Promise<Response> {
  const url = `${adminBase(adminPort)}${path}`
  const opts: RequestInit = { method }
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Caddy admin ${method} ${path}: ${res.status} ${text}`)
  }
  return res
}

// --- Public API ---

export async function ensureCaddy(cfg: CaddyConfig): Promise<ChildProcess | null> {
  // If already running, just return
  try {
    const res = await fetch(`${adminBase(cfg.adminPort)}/config/`)
    if (res.ok) {
      log.info('caddy', `already running (admin :${cfg.adminPort})`)
      return null
    }
  } catch {
    // not running
  }

  // Remove stale container
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' })
  } catch {
    // didn't exist
  }

  mkdirSync(cfg.configDir, { recursive: true })
  const configPath = join(cfg.configDir, 'caddy.json')
  writeFileSync(configPath, JSON.stringify(buildInitialConfig(cfg.listenPort, cfg.adminPort), null, 2))

  try {
    execSync(
      `docker run -d --name ${CONTAINER_NAME} --network host --rm` +
      ` -v ${configPath}:/etc/caddy/caddy.json:ro` +
      ` ${CADDY_IMAGE} caddy run --config /etc/caddy/caddy.json`,
      { stdio: 'pipe' },
    )
  } catch (err) {
    const msg = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? (err as Error).message
    log.error('caddy', `failed to start container: ${msg}`)
    throw new Error(`Failed to start Caddy container: ${msg}`)
  }

  // Stream logs
  const logChild = spawn('docker', ['logs', '-f', CONTAINER_NAME], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  logChild.stdout?.on('data', (d: Buffer) => log.debug('caddy', d.toString().trim()))
  logChild.stderr?.on('data', (d: Buffer) => log.debug('caddy', d.toString().trim()))
  logChild.on('error', () => {})

  await waitForAdmin(cfg.adminPort)
  log.info('caddy', `container started on :${cfg.listenPort}`)
  return logChild
}

export async function stopCaddy(): Promise<void> {
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' })
    log.info('caddy', 'container stopped')
  } catch {
    // not running
  }
}

/** Add a path-based route: /s/{name}/* → localhost:{port}/* */
export async function addRoute(name: string, port: number, adminPort: number): Promise<void> {
  await adminFetch(adminPort, 'POST', '/config/apps/http/servers/main/routes', {
    '@id': `session-${name}`,
    match: [{ path: [`/s/${name}`, `/s/${name}/*`] }],
    handle: [
      {
        handler: 'subroute',
        routes: [
          {
            handle: [
              {
                handler: 'rewrite',
                strip_path_prefix: `/s/${name}`,
              },
              {
                handler: 'reverse_proxy',
                upstreams: [{ dial: `localhost:${port}` }],
                flush_interval: -1,
                transport: {
                  protocol: 'http',
                  read_timeout: 0,
                  write_timeout: 0,
                },
              },
            ],
          },
        ],
      },
    ],
  })
  log.info('caddy', `route added: /s/${name} → :${port}`)
}

export async function removeRoute(name: string, adminPort: number): Promise<void> {
  try {
    await adminFetch(adminPort, 'DELETE', `/id/session-${name}`)
    log.info('caddy', `route removed: /s/${name}`)
  } catch {
    // route may not exist
  }
}

/** Rebuild all routes from active sessions */
export async function syncRoutes(
  sessions: Array<{ name: string; port: number | null; state: string }>,
  adminPort: number,
): Promise<void> {
  const routes = sessions
    .filter(s => (s.state === 'running' || s.state === 'idle' || s.state === 'needs_attention') && s.port)
    .map(s => ({
      '@id': `session-${s.name}`,
      match: [{ path: [`/s/${s.name}`, `/s/${s.name}/*`] }],
      handle: [
        {
          handler: 'subroute',
          routes: [
            {
              handle: [
                {
                  handler: 'rewrite',
                  strip_path_prefix: `/s/${s.name}`,
                },
                {
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: `localhost:${s.port}` }],
                  flush_interval: -1,
                  transport: {
                    protocol: 'http',
                    read_timeout: 0,
                    write_timeout: 0,
                  },
                },
              ],
            },
          ],
        },
      ],
    }))
  await adminFetch(adminPort, 'PATCH', '/config/apps/http/servers/main/routes', routes)
  log.info('caddy', `synced ${routes.length} routes`)
}

/** Get the proxied URL for a session */
export function sessionUrl(name: string, _listenPort: number): string {
  return `/s/${name}/`
}
