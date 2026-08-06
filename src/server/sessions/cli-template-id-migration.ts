import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliTemplate } from './config'
import type { DocumentStore } from '../stores/document-store'

/**
 * CLI templates used to be referenced by their visible name ("Codex (full
 * auto)"). Provider-aware lifecycle adapters moved every reference to a stable
 * ID ("codex-full-auto") so a template can be renamed without orphaning the
 * things pointing at it — but nothing rewrote the data already on disk.
 *
 * A record left holding a name resolves to no template, and the lookups all
 * echo the stored string back, so the user sees "CLI template "Codex (full
 * auto)" is not configured" for a template that is very much configured. It
 * bites three stores:
 *
 *   - session records      → resume/stop/telemetry fail for that session
 *   - entity settings      → new sessions inheriting the setting fail to create
 *   - graveyard tombstones → revive can't resolve the provider
 *   - hand definitions     → spawning that hand fails
 *
 * This pass maps name → ID once at boot. It is idempotent: a value that is
 * already a valid ID is left alone, and so is one matching neither an ID nor a
 * name (an unknown value is someone else's data, not ours to guess at).
 */

export interface CliTemplateIdMigrationReport {
  /** Session names whose record was rewritten. */
  sessions: string[]
  /** `initiative:<id>` / `epic:<id>` / `task:<id>` whose settings were rewritten. */
  entities: string[]
  /** convIds of tombstones that were rewritten. */
  tombstones: string[]
  /** Hand definition filenames whose frontmatter was rewritten. */
  hands: string[]
  /** Values that matched no template at all — left as-is, surfaced for the log. */
  unresolved: Array<{ where: string; value: string }>
}

/** Name → ID for templates whose name is unambiguous. */
function nameIndex(templates: CliTemplate[]): Map<string, string> {
  const seen = new Map<string, string | null>()
  for (const t of templates) {
    // An ambiguous name can't be migrated safely — mark it poisoned so we
    // report it as unresolved rather than picking a template at random.
    seen.set(t.name, seen.has(t.name) ? null : t.id)
  }
  const index = new Map<string, string>()
  for (const [name, id] of seen) if (id) index.set(name, id)
  return index
}

export function migrateCliTemplateIds(
  templates: CliTemplate[],
  sessionsDir: string,
  docStore: DocumentStore,
  handsDir?: string,
): CliTemplateIdMigrationReport {
  const ids = new Set(templates.map(t => t.id))
  const byName = nameIndex(templates)
  const report: CliTemplateIdMigrationReport = { sessions: [], entities: [], tombstones: [], hands: [], unresolved: [] }

  /** Returns the ID to write, or null to leave the value alone. */
  const resolve = (value: unknown, where: string): string | null => {
    if (typeof value !== 'string' || !value) return null
    if (ids.has(value)) return null
    const id = byName.get(value)
    if (!id) {
      report.unresolved.push({ where, value })
      return null
    }
    return id
  }

  // --- Session records -----------------------------------------------------
  let entries: string[] = []
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    entries = []
  }

  for (const name of entries) {
    const file = join(sessionsDir, name, 'session.json')
    let record: Record<string, unknown>
    try {
      record = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      continue // no record, or unreadable — reconcile deals with those
    }
    const id = resolve(record.cliTemplate, `session:${name}`)
    if (!id) continue
    record.cliTemplate = id
    try {
      writeFileSync(file, JSON.stringify(record, null, 2))
      report.sessions.push(name)
    } catch {
      report.unresolved.push({ where: `session:${name}`, value: String(record.cliTemplate) })
    }
  }

  // --- Entity settings -----------------------------------------------------
  type SettingsBearer = { id: string; settings?: { cliTemplate?: string } }
  const tiers: Array<{ kind: string; all: () => SettingsBearer[]; put: (e: SettingsBearer) => void }> = [
    { kind: 'initiative', all: () => docStore.getAllInitiatives(), put: e => docStore.upsertInitiative(e.id, e as never) },
    { kind: 'epic', all: () => docStore.getAllEpics(), put: e => docStore.upsertEpic(e.id, e as never) },
    { kind: 'task', all: () => docStore.getAllTasks(), put: e => docStore.upsertTask(e.id, e as never) },
  ]

  for (const tier of tiers) {
    for (const entity of tier.all()) {
      const settings = entity.settings
      if (!settings) continue
      const id = resolve(settings.cliTemplate, `${tier.kind}:${entity.id}`)
      if (!id) continue
      tier.put({ ...entity, settings: { ...settings, cliTemplate: id } })
      report.entities.push(`${tier.kind}:${entity.id}`)
    }
  }

  // --- Graveyard tombstones ------------------------------------------------
  for (const tombstone of docStore.getAllTombstones()) {
    const id = resolve(tombstone.cliTemplate, `tombstone:${tombstone.convId}`)
    if (!id) continue
    docStore.upsertTombstone({ ...tombstone, cliTemplate: id })
    report.tombstones.push(tombstone.convId)
  }

  // --- Hand definitions ----------------------------------------------------
  // Hand files are hand-authored markdown, so this rewrites the single
  // `cliTemplate:` line in the frontmatter rather than round-tripping the YAML
  // — comments, key order and body all survive untouched.
  if (handsDir) {
    let handFiles: string[] = []
    try {
      handFiles = readdirSync(handsDir).filter(f => f.endsWith('.md'))
    } catch {
      handFiles = []
    }

    for (const file of handFiles) {
      const path = join(handsDir, file)
      let content: string
      try {
        content = readFileSync(path, 'utf-8')
      } catch {
        continue
      }

      const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)
      if (!frontmatter) continue
      const line = frontmatter[1]!.match(/^cliTemplate:[ \t]*(.+?)[ \t]*$/m)
      if (!line) continue

      // Tolerate the quoting styles YAML allows for a plain scalar.
      const current = line[1]!.replace(/^(['"])(.*)\1$/, '$2')
      const id = resolve(current, `hand:${file}`)
      if (!id) continue

      const rewritten = content.replace(frontmatter[0], block =>
        block.replace(/^cliTemplate:[ \t]*.+?[ \t]*$/m, `cliTemplate: ${id}`))
      try {
        writeFileSync(path, rewritten)
        report.hands.push(file)
      } catch {
        report.unresolved.push({ where: `hand:${file}`, value: current })
      }
    }
  }

  return report
}
