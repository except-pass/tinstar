// `npm run surfaces:diagnose` — the operator entry point for U1's migration
// diagnostics.
//
// This is an OPERATOR command, not a startup path. Nothing here is wired into
// boot, and nothing here writes: it reads a `docstore.json` and the Surface
// sidecar, rehearses the migration in memory, and prints what it found. Pointing
// it at a copy of a real docstore is the intended way to use it.
//
// It lives under `src/` rather than in `bin/` on purpose. `bin/` is plain JS that
// either shells out or talks to the running server's HTTP API; this needs the
// TypeScript migration module itself, which is not in the shipped `dist/server`
// bundle (nothing calls it yet). Running it through `tsx`, the same runner
// `npm run dev:backend` uses, keeps it honest — it exercises the real source, not
// a stale build.

import { pathToFileURL } from 'node:url'
import {
  collectMigrationDiagnostics,
  migrationDiagnosticsJson,
  renderMigrationDiagnostics,
} from './surface-diagnostics'

const USAGE = `
Surface migration diagnostics — a read-only rehearsal of the legacy Slate →
canonical Surface migration. Writes nothing, takes no lock, creates no files.

  usage: npm run surfaces:diagnose -- [options]

  --docstore <path>     docstore.json to read (default: <config root>/docstore.json)
  --sidecar-dir <dir>   directory holding surfaces.json (default: <config root>)
  --all                 list every run and every entry instead of a sample
  --json                machine-readable dump (the human-readable form is the default)
  --no-color            plain text; also implied when output is not a terminal
  -h, --help            this text

  exit codes: 0 nothing is broken · 1 the sidecar is faulted or the docstore is
  unreadable · 2 bad usage. Quarantined entries do NOT fail the command — they are
  a finding to read, not a crash.
`

export interface CliOptions {
  docstorePath?: string
  sidecarDir?: string
  all: boolean
  json: boolean
  color: boolean
  help: boolean
}

export type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string }

/** Colour is opt-out, and off by default whenever output is redirected — a dump
 *  someone pipes into a file or a ticket must not carry escape codes. */
export function parseDiagnosticsArgs(argv: readonly string[], isTty = false): ParseResult {
  const options: CliOptions = {
    all: false,
    json: false,
    color: isTty && !process.env.NO_COLOR,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string | undefined => argv[++i]
    switch (arg) {
      case '--docstore': {
        const v = next()
        if (!v) return { ok: false, error: '--docstore needs a path' }
        options.docstorePath = v
        break
      }
      case '--sidecar-dir': {
        const v = next()
        if (!v) return { ok: false, error: '--sidecar-dir needs a directory' }
        options.sidecarDir = v
        break
      }
      case '--all': options.all = true; break
      case '--json': options.json = true; break
      case '--no-color': options.color = false; break
      case '--color': options.color = true; break
      case '-h':
      case '--help': options.help = true; break
      default:
        return { ok: false, error: `unknown option: ${arg}` }
    }
  }
  return { ok: true, options }
}

/** Run the command and return its exit code. Takes its writers so a test can run
 *  the whole thing without touching the process. */
export function runDiagnosticsCli(
  argv: readonly string[],
  io: { out: (s: string) => void; err: (s: string) => void; isTty?: boolean } ,
): number {
  const parsed = parseDiagnosticsArgs(argv, io.isTty ?? false)
  if (!parsed.ok) {
    io.err(`\n✗ ${parsed.error}\n${USAGE}`)
    return 2
  }
  if (parsed.options.help) {
    io.out(USAGE)
    return 0
  }
  const { docstorePath, sidecarDir, all, json, color } = parsed.options
  const diagnostics = collectMigrationDiagnostics({
    ...(docstorePath ? { docstorePath } : {}),
    ...(sidecarDir ? { sidecarDir } : {}),
  })
  io.out(
    json
      ? JSON.stringify(migrationDiagnosticsJson(diagnostics), null, 2)
      : renderMigrationDiagnostics(diagnostics, { color, allRuns: all }),
  )
  const broken =
    diagnostics.sidecar.outcome.health === 'faulted-read-only' || !diagnostics.legacy.ok
  return broken ? 1 : 0
}

// Only when invoked as the program — importing this module (a test, another tool)
// must not run a command as a side effect.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runDiagnosticsCli(process.argv.slice(2), {
    out: s => console.log(s),
    err: s => console.error(s),
    isTty: !!process.stdout.isTTY,
  })
}
