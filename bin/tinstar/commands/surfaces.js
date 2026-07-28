// bin/tinstar/commands/surfaces.js — canonical Surface primitives from the shell.
//
// The plan's Agent-Native Action Parity table is a contract: any action a human
// can take through the UI, an agent can take through the API or the CLI. This
// file is the CLI half, and it is DELIBERATELY DUMB. It turns argv into one HTTP
// request and prints what came back. It validates nothing beyond "did you give
// me the arguments this subcommand needs", because every rule about what a
// Surface mutation may contain lives in the server's `SurfaceService` — and if
// the CLI re-implemented any of them, the two would drift and an agent would get
// a different answer depending on which door it came through.
//
// `buildRequest` and the renderers are exported and pure so the parity claim is
// testable without a server, and `tests/cli/tinstar-surfaces.test.ts` also runs
// them against a REAL route server to prove the conflict and recovery states
// come back identical to the HTTP ones.

import { httpJson } from '../http.js'
import { getApiBase } from '../../apiBase.js'

const USAGE = `usage: tinstar surfaces <command>

  list [--space <id>] [--deleted]        list a space's Surfaces
  get <id>                               one Surface and its capabilities
  context <id>                           ancestors, children, contributors, freshness
  contributors <id>                      who worked on it and what can be opened

  create --space <id> --home <canvas|surfaceId> --headline <text>
         [--recipe <text>] [--run <runId>] [--worktree <id>]
  update <id> --rev <n> [--headline <text>] [--recipe <text>|--clear-recipe]
  authority <id> --rev <n> --to <canonical-direct|source-binding>
  thread <id> --text <text> [--author <user|agent|process>]
  refresh <id>

  group <childId,...> --headline <text>  fold siblings into one new parent
  reparent <id,...> --home <canvas|surfaceId>
  ungroup <id>                           dissolve a parent; children move up

  delete <id> [--descendants <a,b>] [--disposition <reparent-children|delete-subtree>]
  restore <id>                           undo a delete
  purge <id> [--descendants <a,b>]       ERASE a deleted subtree. Irreversible;
                                         a subtree with descendants must name them.

  --json                                 print the raw response envelope
  --idempotency-key <k>                  make a retry safe after a lost response`

/** Read `--flag value` pairs and bare `--flag` switches out of argv. */
function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i++
    }
  }
  return flags
}

function required(flags, name, sub) {
  const value = flags[name]
  if (typeof value !== 'string' || !value) throw new Error(`surfaces ${sub}: --${name} is required`)
  return value
}

function commaList(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`surfaces: ${label} is required`)
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

/** `canvas` means the space's Canvas home; anything else is a Surface id. The
 *  recovery store is deliberately unnameable here, exactly as it is over HTTP —
 *  moving something there is `delete`, which records how to undo it. */
function homeFrom(value, spaceId, sub) {
  if (typeof value !== 'string' || !value) throw new Error(`surfaces ${sub}: --home is required`)
  if (value === 'canvas') {
    if (!spaceId) throw new Error(`surfaces ${sub}: --home canvas needs --space <id>`)
    return { kind: 'canvas', spaceId }
  }
  return { kind: 'surface', surfaceId: value }
}

const enc = encodeURIComponent

/**
 * argv → one HTTP request. PURE: no network, no environment, no clock, so the
 * mapping from a command line to an API call can be asserted directly.
 *
 * Returns `{ method, path, body }`, or throws an Error whose message is what the
 * user should see.
 */
export function buildRequest(argv) {
  const sub = argv[3]
  const rest = argv.slice(4)
  const flags = parseFlags(rest)
  // Exactly one positional is ever meaningful, and it is always first: a Surface
  // id, or a comma-separated id list. Everything else is a flag.
  const first = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined

  switch (sub) {
    case 'list': {
      const params = new URLSearchParams()
      if (typeof flags.space === 'string') params.set('spaceId', flags.space)
      if (flags.deleted) params.set('includeDeleted', 'true')
      const query = params.toString()
      return { method: 'GET', path: `/api/surfaces${query ? `?${query}` : ''}` }
    }
    case 'get':
      if (!first) throw new Error('surfaces get: <id> is required')
      return { method: 'GET', path: `/api/surfaces/${enc(first)}` }
    case 'context':
      if (!first) throw new Error('surfaces context: <id> is required')
      return { method: 'GET', path: `/api/surfaces/${enc(first)}/context` }
    case 'contributors':
      if (!first) throw new Error('surfaces contributors: <id> is required')
      return { method: 'GET', path: `/api/surfaces/${enc(first)}/contributors` }

    case 'create': {
      const spaceId = required(flags, 'space', 'create')
      const body = {
        spaceId,
        home: homeFrom(flags.home, spaceId, 'create'),
        content: {
          headline: required(flags, 'headline', 'create'),
          ...(typeof flags.recipe === 'string' ? { recipe: flags.recipe } : {}),
        },
      }
      const provenance = {
        ...(typeof flags.run === 'string' ? { runId: flags.run } : {}),
        ...(typeof flags.worktree === 'string' ? { worktreeId: flags.worktree } : {}),
      }
      if (Object.keys(provenance).length > 0) body.provenance = provenance
      return { method: 'POST', path: '/api/surfaces', body }
    }
    case 'update': {
      if (!first) throw new Error('surfaces update: <id> is required')
      const rev = Number(required(flags, 'rev', 'update'))
      if (!Number.isFinite(rev)) throw new Error('surfaces update: --rev must be a number')
      const body = { expectedRev: rev }
      if (typeof flags.headline === 'string') body.headline = flags.headline
      // An explicit clear is its own flag rather than `--recipe ""`: an empty
      // string is indistinguishable from a shell quoting mistake, and clearing a
      // refresh recipe by accident is how a Surface silently stops updating.
      if (flags['clear-recipe']) body.recipe = null
      else if (typeof flags.recipe === 'string') body.recipe = flags.recipe
      return { method: 'PATCH', path: `/api/surfaces/${enc(first)}/content`, body }
    }
    case 'authority': {
      if (!first) throw new Error('surfaces authority: <id> is required')
      const rev = Number(required(flags, 'rev', 'authority'))
      if (!Number.isFinite(rev)) throw new Error('surfaces authority: --rev must be a number')
      return {
        method: 'POST',
        path: `/api/surfaces/${enc(first)}/authority`,
        body: { to: required(flags, 'to', 'authority'), expectedRev: rev },
      }
    }
    case 'thread': {
      if (!first) throw new Error('surfaces thread: <id> is required')
      return {
        method: 'POST',
        path: `/api/surfaces/${enc(first)}/thread`,
        body: {
          text: required(flags, 'text', 'thread'),
          ...(typeof flags.author === 'string' ? { author: flags.author } : {}),
        },
      }
    }
    case 'refresh':
      if (!first) throw new Error('surfaces refresh: <id> is required')
      return { method: 'POST', path: `/api/surfaces/${enc(first)}/refresh`, body: {} }

    case 'group': {
      const childIds = commaList(first, 'surfaces group: <childId,...>')
      return {
        method: 'POST',
        path: '/api/surfaces/group',
        body: { childIds, content: { headline: required(flags, 'headline', 'group') } },
      }
    }
    case 'reparent': {
      const ids = commaList(first, 'surfaces reparent: <id,...>')
      return {
        method: 'POST',
        path: '/api/surfaces/reparent',
        body: { ids, home: homeFrom(flags.home, flags.space, 'reparent') },
      }
    }
    case 'ungroup':
      if (!first) throw new Error('surfaces ungroup: <id> is required')
      return { method: 'POST', path: `/api/surfaces/${enc(first)}/ungroup`, body: {} }

    case 'delete': {
      if (!first) throw new Error('surfaces delete: <id> is required')
      const body = {}
      if (typeof flags.descendants === 'string') {
        body.descendants = flags.descendants.split(',').map(s => s.trim()).filter(Boolean)
      }
      if (typeof flags.disposition === 'string') body.disposition = flags.disposition
      return { method: 'DELETE', path: `/api/surfaces/${enc(first)}`, body }
    }
    case 'restore':
      if (!first) throw new Error('surfaces restore: <id> is required')
      return { method: 'POST', path: `/api/surfaces/${enc(first)}/restore`, body: {} }
    case 'purge': {
      if (!first) throw new Error('surfaces purge: <id> is required')
      // Same compare-and-swap `delete` takes, and required for the same reason —
      // more so, since a purge has no undo. The server refuses a subtree whose
      // descendants the caller did not name.
      const body = {}
      if (typeof flags.descendants === 'string') {
        body.descendants = flags.descendants.split(',').map(s => s.trim()).filter(Boolean)
      }
      return { method: 'DELETE', path: `/api/surfaces/${enc(first)}/purge`, body }
    }

    default:
      throw new Error(USAGE)
  }
}

/** One line per Surface: id, revision, home, headline. */
function renderListing(data) {
  const lines = []
  for (const { surface } of data.surfaces) {
    const home = surface.home.kind === 'canvas' ? 'canvas'
      : surface.home.kind === 'recovery' ? 'recovery'
        : surface.home.surfaceId
    lines.push(`${surface.id}\trev ${surface.rev}\t${home}\t${surface.content.headline}`)
  }
  lines.push(`topologyRev ${data.topologyRev}\troots ${data.rootIds.length}\trecoverable ${data.recoveryIds.length}`)
  return lines.join('\n')
}

/**
 * Turn a successful envelope into text.
 *
 * `replayed` is printed rather than swallowed. A retry after a lost response is
 * supposed to be a no-op, and a caller that cannot see the difference between
 * "applied" and "already applied" will eventually write a script that assumes
 * one and gets the other.
 */
export function renderSuccess(sub, data) {
  if (sub === 'list') return renderListing(data)
  if (sub === 'get') {
    const caps = Object.entries(data.capabilities)
      .filter(([, v]) => v === true).map(([k]) => k).join(' ')
    return `${data.surface.id}\trev ${data.surface.rev}\t${data.surface.content.headline}\ncan: ${caps}`
  }
  if (sub === 'context') {
    const crumbs = data.ancestors.map(a => a.headline || a.id).join(' / ')
    const kids = data.children.map(c => `  ${c.id}\t${c.accessible ? c.headline : `[withheld: ${c.withheld}]`}`)
    return [
      `${data.surface.id}\trev ${data.surface.rev}\t${data.surface.content.headline}`,
      crumbs ? `path: ${crumbs}` : 'path: canvas',
      `freshness: ${data.surface.freshness.phase}${data.surface.freshness.overdue ? ' (overdue)' : ''}`,
      `descendants: ${data.descendantCount}`,
      ...(kids.length > 0 ? ['children:', ...kids] : []),
      ...(data.deleted ? [`deleted at ${new Date(data.deleted.at).toISOString()} (${data.deleted.disposition})`] : []),
    ].join('\n')
  }
  if (sub === 'contributors') {
    if (data.contributors.length === 0) return 'no contributors recorded'
    return data.contributors
      .map(c => `${c.principal.kind}:${c.principal.id}\t${c.role}\t${c.resolution}${c.terminal ? '\tterminal' : ''}`)
      .join('\n')
  }
  // Every mutation.
  const ids = data.surfaces.map(s => `${s.surface.id} rev ${s.surface.rev}`).join(', ')
  const lines = [
    `${data.op}${data.replayed ? ' (replayed — nothing was re-applied)' : ''}`,
    `topologyRev ${data.baseTopologyRev} -> ${data.topologyRev}`,
  ]
  if (ids) lines.push(ids)
  if (data.purged?.length) lines.push(`purged: ${data.purged.join(', ')}`)
  return lines.join('\n')
}

/**
 * Turn a failure envelope into text.
 *
 * The store's own reason code is printed alongside the message, and the
 * authoritative records are summarised, because the plan requires the CLI to
 * report "the same conflict and recovery states" as HTTP. A CLI that printed
 * only "conflict" would be strictly less informative than the API it wraps.
 */
export function renderFailure(error) {
  const lines = [`error ${error.code}${error.details?.reason ? ` (${error.details.reason})` : ''}: ${error.message}`]
  if (error.details?.topologyRev !== undefined) lines.push(`current topologyRev ${error.details.topologyRev}`)
  for (const current of error.details?.current ?? []) {
    lines.push(`current: ${current.id} rev ${current.rev} ${current.content?.headline ?? ''}`)
  }
  return lines.join('\n')
}

export async function run(argv) {
  const sub = argv[3]
  if (!sub || sub === 'help' || sub === '--help') {
    console.log(USAGE)
    return
  }
  const request = buildRequest(argv)
  const flags = parseFlags(argv.slice(4))
  const headers = {}
  // The trusted-local routing identity the plan specifies for direct agent CLI
  // calls: the managed session's own name, which tmux exports into every session.
  // Absent (a human at a terminal) the server defaults to the local human actor.
  if (process.env.TINSTAR_SESSION_NAME) {
    headers['X-Tinstar-Actor'] = process.env.TINSTAR_SESSION_NAME
    headers['X-Tinstar-Actor-Kind'] = 'session'
  }
  if (typeof flags['idempotency-key'] === 'string') {
    headers['Idempotency-Key'] = flags['idempotency-key']
  }

  const res = await httpJson(`${getApiBase()}${request.path}`, {
    method: request.method,
    ...(request.body !== undefined ? { body: request.body } : {}),
    headers,
  })

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2))
    if (res.ok === false) process.exitCode = 1
    return
  }
  if (res.ok === false) {
    console.error(renderFailure(res.error))
    process.exitCode = 1
    return
  }
  console.log(renderSuccess(sub, res.data))
}
