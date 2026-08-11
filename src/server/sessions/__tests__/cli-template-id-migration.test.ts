import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateCliTemplateIds } from '../cli-template-id-migration'
import { DocumentStore } from '../../stores/document-store'
import type { CliTemplate } from '../config'

const TEMPLATES: CliTemplate[] = [
  { id: 'claude-multi-agent', name: 'Claude (multi-agent)', adapter: 'claude', startCmd: 'x', resumeCmd: 'y' },
  { id: 'codex-full-auto', name: 'Codex (full auto)', adapter: 'codex', startCmd: 'x', resumeCmd: 'y' },
]

let dir: string

function writeSession(name: string, cliTemplate: string | null): string {
  const sessionDir = join(dir, name)
  mkdirSync(sessionDir, { recursive: true })
  const file = join(sessionDir, 'session.json')
  writeFileSync(file, JSON.stringify({ name, cliTemplate, adapter: 'codex' }, null, 2))
  return file
}

function readTemplate(name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name, 'session.json'), 'utf-8')).cliTemplate
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tinstar-clitpl-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('migrateCliTemplateIds', () => {
  it('rewrites a session record that stores the display name to the stable ID', () => {
    writeSession('enrollment', 'Codex (full auto)')

    const report = migrateCliTemplateIds(TEMPLATES, dir, new DocumentStore())

    expect(readTemplate('enrollment')).toBe('codex-full-auto')
    expect(report.sessions).toEqual(['enrollment'])
  })

  it('leaves records that already hold a valid ID untouched', () => {
    writeSession('good', 'codex-full-auto')
    writeSession('none', null)

    const report = migrateCliTemplateIds(TEMPLATES, dir, new DocumentStore())

    expect(readTemplate('good')).toBe('codex-full-auto')
    expect(readTemplate('none')).toBe(null)
    expect(report.sessions).toEqual([])
    expect(report.unresolved).toEqual([])
  })

  it('reports — and does not clobber — a value matching neither an ID nor a name', () => {
    writeSession('mystery', 'docker:DeploymentMonitor')

    const report = migrateCliTemplateIds(TEMPLATES, dir, new DocumentStore())

    expect(readTemplate('mystery')).toBe('docker:DeploymentMonitor')
    expect(report.unresolved).toContainEqual({ where: 'session:mystery', value: 'docker:DeploymentMonitor' })
  })

  it('rewrites entity settings on initiatives, epics and tasks', () => {
    const store = new DocumentStore()
    store.upsertInitiative('init-1', {
      id: 'init-1', name: 'Init', settings: { cliTemplate: 'Claude (multi-agent)' },
    } as never)
    store.upsertEpic('epic-1', {
      id: 'epic-1', name: 'Epic', settings: { cliTemplate: 'Codex (full auto)' },
    } as never)
    store.upsertTask('task-1', {
      id: 'task-1', name: 'Task', settings: { cliTemplate: 'claude-multi-agent' },
    } as never)

    const report = migrateCliTemplateIds(TEMPLATES, dir, store)

    expect(store.getInitiative('init-1')!.settings!.cliTemplate).toBe('claude-multi-agent')
    expect(store.getEpic('epic-1')!.settings!.cliTemplate).toBe('codex-full-auto')
    expect(store.getTask('task-1')!.settings!.cliTemplate).toBe('claude-multi-agent')
    expect(report.entities.sort()).toEqual(['epic:epic-1', 'initiative:init-1'])
  })

  it('rewrites graveyard tombstones so revive resolves a provider', () => {
    const store = new DocumentStore()
    store.upsertTombstone({
      convId: 'conv-1', sessionName: 'old', coversSummary: '', cliTemplate: 'Codex (full auto)',
    } as never)

    const report = migrateCliTemplateIds(TEMPLATES, dir, store)

    expect(store.getTombstone('conv-1')!.cliTemplate).toBe('codex-full-auto')
    expect(report.tombstones).toEqual(['conv-1'])
  })

  it('rewrites the cliTemplate line in hand frontmatter, leaving the rest byte-identical', () => {
    const handsDir = join(dir, 'hands')
    mkdirSync(handsDir)
    const original = [
      '---',
      'name: fixer',
      'description: Fixes things',
      'cliTemplate: Claude (multi-agent)',
      '---',
      '',
      'You are the fixer. cliTemplate: Claude (multi-agent) appears in the body too.',
      '',
    ].join('\n')
    writeFileSync(join(handsDir, 'fixer.md'), original)

    const report = migrateCliTemplateIds(TEMPLATES, dir, new DocumentStore(), handsDir)

    const after = readFileSync(join(handsDir, 'fixer.md'), 'utf-8')
    expect(after).toBe(original.replace('cliTemplate: Claude (multi-agent)\n---', 'cliTemplate: claude-multi-agent\n---'))
    // The body mention must survive — only the frontmatter key is ours to touch.
    expect(after).toContain('body too.')
    expect(after).toContain('cliTemplate: Claude (multi-agent) appears in the body')
    expect(report.hands).toEqual(['fixer.md'])
  })

  it('accepts a quoted frontmatter value', () => {
    const handsDir = join(dir, 'hands')
    mkdirSync(handsDir)
    writeFileSync(join(handsDir, 'q.md'), '---\nname: q\ncliTemplate: "Codex (full auto)"\n---\n\nbody\n')

    migrateCliTemplateIds(TEMPLATES, dir, new DocumentStore(), handsDir)

    expect(readFileSync(join(handsDir, 'q.md'), 'utf-8')).toContain('cliTemplate: codex-full-auto')
  })

  it('is idempotent — a second pass rewrites nothing', () => {
    writeSession('enrollment', 'Codex (full auto)')
    const store = new DocumentStore()
    store.upsertTask('task-1', { id: 'task-1', name: 'T', settings: { cliTemplate: 'Codex (full auto)' } } as never)

    migrateCliTemplateIds(TEMPLATES, dir, store)
    const second = migrateCliTemplateIds(TEMPLATES, dir, store)

    expect(second.sessions).toEqual([])
    expect(second.entities).toEqual([])
    expect(second.unresolved).toEqual([])
  })
})
