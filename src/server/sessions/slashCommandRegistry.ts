import { readdirSync, readFileSync, statSync, watch, FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SlashCommand } from '../../lib/slashMatching'

export interface DiscoverOpts {
  home?: string  // defaults to os.homedir()
  cwd?: string   // defaults to process.cwd()
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(FRONTMATTER_RE)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) out[key] = val
  }
  return out
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
function safeStatIsDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}
function safeRead(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function loadCommandsDir(dir: string, source: SlashCommand['source']): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -3)
    const text = safeRead(join(dir, entry))
    if (text == null) continue
    const fm = parseFrontmatter(text)
    out.push({
      name,
      description: fm['description'] ?? '',
      source,
      argumentHint: fm['argument-hint'] ?? null,
    })
  }
  return out
}

function loadSkillsDir(dir: string, source: SlashCommand['source'], namespace?: string): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const entry of safeReaddir(dir)) {
    const skillDir = join(dir, entry)
    if (!safeStatIsDir(skillDir)) continue
    const text = safeRead(join(skillDir, 'SKILL.md'))
    if (text == null) continue
    const fm = parseFrontmatter(text)
    const baseName = fm['name'] ?? entry
    const name = namespace ? `${namespace}:${baseName}` : baseName
    out.push({
      name,
      description: fm['description'] ?? '',
      source,
    })
  }
  return out
}

function loadPluginCache(pluginsCacheDir: string): SlashCommand[] {
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{commands,skills}
  const out: SlashCommand[] = []
  for (const marketplace of safeReaddir(pluginsCacheDir)) {
    const mDir = join(pluginsCacheDir, marketplace)
    if (!safeStatIsDir(mDir)) continue
    for (const plugin of safeReaddir(mDir)) {
      const pDir = join(mDir, plugin)
      if (!safeStatIsDir(pDir)) continue
      for (const version of safeReaddir(pDir)) {
        const vDir = join(pDir, version)
        if (!safeStatIsDir(vDir)) continue
        out.push(...loadCommandsDir(join(vDir, 'commands'), 'plugin'))
        out.push(...loadSkillsDir(join(vDir, 'skills'), 'plugin-skill', plugin))
      }
    }
  }
  return out
}

/**
 * Claude Code built-in slash commands. These are baked into the `claude` binary,
 * not on disk, so the filesystem scan can't find them. Curated by hand from
 * literal `"/<name>"` strings present in the binary and re-verified on CC version
 * bumps via `scripts/audit-cc-builtins.mjs`.
 *
 * Last verified against: claude 2.1.129
 *
 * Note: this is a conservative subset. Commands that CC constructs as
 * `"/" + name` (rather than a literal) won't appear in the binary scan and
 * must be added manually after confirming with the in-app `/help` panel.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: 'agents',         description: 'Manage background and configured agents',    source: 'builtin' },
  { name: 'clear',          description: 'Clear the conversation',                     source: 'builtin' },
  { name: 'compact',        description: 'Compact the conversation',                   source: 'builtin' },
  { name: 'config',         description: 'Open settings',                              source: 'builtin' },
  { name: 'exit',           description: 'Exit the session',                           source: 'builtin' },
  { name: 'fast',           description: 'Toggle Opus fast mode',                      source: 'builtin' },
  { name: 'feedback',       description: 'Submit feedback to Anthropic',               source: 'builtin' },
  { name: 'hooks',          description: 'Manage hooks',                               source: 'builtin' },
  { name: 'init',           description: 'Initialize a CLAUDE.md for the project',     source: 'builtin' },
  { name: 'login',          description: 'Sign in',                                    source: 'builtin' },
  { name: 'logout',         description: 'Sign out',                                   source: 'builtin' },
  { name: 'loop',           description: 'Run a prompt or slash command on a loop',    source: 'builtin' },
  { name: 'mcp',            description: 'Manage MCP servers',                         source: 'builtin' },
  { name: 'memory',         description: 'Edit auto-memory',                           source: 'builtin' },
  { name: 'model',          description: 'Switch model',                               source: 'builtin' },
  { name: 'permissions',    description: 'Manage permissions',                         source: 'builtin' },
  { name: 'quit',           description: 'Exit the session',                           source: 'builtin' },
  { name: 'remote-control', description: 'Open remote control',                        source: 'builtin' },
  { name: 'resume',         description: 'Resume a previous session',                  source: 'builtin' },
  { name: 'rewind',         description: 'Rewind to an earlier checkpoint',            source: 'builtin' },
  { name: 'status',         description: 'Show session status',                        source: 'builtin' },
  { name: 'teleport',       description: 'Teleport to another session',                source: 'builtin' },
  { name: 'ultrareview',    description: 'Run a cloud-hosted multi-agent code review', source: 'builtin' },
]

/**
 * Merge filesystem-discovered commands with built-ins. If a name collides
 * (e.g. user has `~/.claude/skills/init/SKILL.md` shadowing the built-in
 * `/init`), the filesystem entry wins so user customization is preserved.
 */
function mergeWithBuiltins(discovered: SlashCommand[]): SlashCommand[] {
  const seen = new Set(discovered.map(c => c.name))
  const builtins = BUILTIN_SLASH_COMMANDS.filter(c => !seen.has(c.name))
  return [...discovered, ...builtins]
}

export async function discoverSlashCommands(opts: DiscoverOpts = {}): Promise<SlashCommand[]> {
  const home = opts.home ?? homedir()
  const cwd  = opts.cwd  ?? process.cwd()
  const discovered = [
    ...loadCommandsDir(join(cwd, '.claude/commands'), 'project'),
    ...loadSkillsDir(join(cwd, '.claude/skills'), 'project-skill'),
    ...loadCommandsDir(join(home, '.claude/commands'), 'user'),
    ...loadSkillsDir(join(home, '.claude/skills'), 'user-skill'),
    ...loadPluginCache(join(home, '.claude/plugins/cache')),
  ]
  return mergeWithBuiltins(discovered)
}

export class SlashCommandRegistry {
  private cache: SlashCommand[] | null = null
  private watchers: FSWatcher[] = []
  private opts: DiscoverOpts

  constructor(opts: DiscoverOpts = {}) {
    this.opts = opts
  }

  async list(): Promise<SlashCommand[]> {
    if (this.cache) return this.cache
    const cmds = await discoverSlashCommands(this.opts)
    this.cache = cmds
    this.installWatchers()
    return cmds
  }

  invalidate(): void {
    this.cache = null
  }

  dispose(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* already closed */ }
    }
    this.watchers = []
    this.cache = null
  }

  private installWatchers(): void {
    if (this.watchers.length > 0) return
    const home = this.opts.home ?? homedir()
    const cwd  = this.opts.cwd  ?? process.cwd()
    const dirs = [
      join(cwd,  '.claude/commands'),
      join(cwd,  '.claude/skills'),
      join(home, '.claude/commands'),
      join(home, '.claude/skills'),
      join(home, '.claude/plugins/cache'),
    ]
    for (const d of dirs) {
      try {
        const w = watch(d, { recursive: true }, () => this.invalidate())
        this.watchers.push(w)
      } catch {
        // Directory may not exist yet — that's fine, no rescan needed for it.
      }
    }
  }
}
