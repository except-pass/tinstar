// src/server/sessions/skill-discovery.ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import type { SkillDTO } from '../../types'

// Internal full type (path not sent to client)
export interface Skill extends SkillDTO {
  path: string
}

/** Parse YAML-style frontmatter from a markdown file. Returns {} if none. */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = val
  }
  return result
}

function scanDir(dir: string, source: SkillDTO['source']): Skill[] {
  const skills: Skill[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return skills  // directory missing — fine
  }
  for (const name of entries) {
    if (extname(name) !== '.md') continue
    const path = join(dir, name)
    try {
      const content = readFileSync(path, 'utf-8')
      const fm = parseFrontmatter(content)
      skills.push({
        name: fm.name ?? name.replace(/\.md$/, ''),
        description: fm.description,
        source,
        path,
      })
    } catch {
      // skip unreadable files
    }
  }
  return skills
}

function scanPlugins(): Skill[] {
  const pluginsDir = join(homedir(), '.claude', 'plugins', 'cache')
  const skills: Skill[] = []
  // Real directory structure: cache/<registry>/<plugin-name>/<version>/skills/<skill-name>/
  // e.g. cache/claude-plugins-official/superpowers/5.0.2/skills/brainstorming/
  function walk(dir: string, depth: number): void {
    if (depth > 5) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch { return }

    // If this directory contains a 'skills' subdir, scan it
    if (entries.includes('skills')) {
      const skillsDir = join(dir, 'skills')
      try {
        // Check if SKILL.md is directly in skills/ (flat single-skill plugin)
        const flatSkillPath = join(skillsDir, 'SKILL.md')
        let flatHandled = false
        try {
          const content = readFileSync(flatSkillPath, 'utf-8')
          const fm = parseFrontmatter(content)
          const skillName = fm.name ?? dir.split('/').pop() ?? 'unknown'
          if (!skills.some(s => s.name === skillName)) {
            skills.push({ name: skillName, description: fm.description, source: 'plugin', path: flatSkillPath })
          }
          flatHandled = true
        } catch { /* no flat SKILL.md */ }

        if (!flatHandled) {
          for (const skillName of readdirSync(skillsDir)) {
            const skillDir = join(skillsDir, skillName)
            try {
              if (!statSync(skillDir).isDirectory()) continue
            } catch { continue }
            for (const candidate of [`${skillName}.md`, 'SKILL.md', 'skill.md', 'index.md']) {
              const mdPath = join(skillDir, candidate)
              try {
                const content = readFileSync(mdPath, 'utf-8')
                const fm = parseFrontmatter(content)
                // Avoid duplicates from multiple versions — skip if name already seen
                if (!skills.some(s => s.name === (fm.name ?? skillName))) {
                  skills.push({
                    name: fm.name ?? skillName,
                    description: fm.description,
                    source: 'plugin',
                    path: mdPath,
                  })
                }
                break
              } catch { /* try next candidate */ }
            }
          }
        }
      } catch { /* no skills dir readable */ }
      return  // don't recurse into skills/ subdirs
    }

    // Otherwise recurse into subdirectories
    for (const entry of entries) {
      const childPath = join(dir, entry)
      try {
        if (statSync(childPath).isDirectory()) walk(childPath, depth + 1)
      } catch { /* skip */ }
    }
  }

  walk(pluginsDir, 0)
  return skills
}

// --- TTL cache ---

interface Cache {
  skills: Skill[]
  expiresAt: number
}

let cache: Cache | null = null
const TTL_MS = 7_000

/** Scan ~/.claude/skills/ — each subdir is a skill with a SKILL.md */
function scanUserSkillsDir(): Skill[] {
  const skillsDir = join(homedir(), '.claude', 'skills')
  const skills: Skill[] = []
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return skills
  }
  for (const skillName of entries) {
    const skillDir = join(skillsDir, skillName)
    try {
      if (!statSync(skillDir).isDirectory()) continue
    } catch { continue }
    for (const candidate of [`${skillName}.md`, 'SKILL.md', 'skill.md', 'index.md']) {
      const mdPath = join(skillDir, candidate)
      try {
        const content = readFileSync(mdPath, 'utf-8')
        const fm = parseFrontmatter(content)
        skills.push({
          name: fm.name ?? skillName,
          description: fm.description,
          source: 'system',
          path: mdPath,
        })
        break
      } catch { /* try next candidate */ }
    }
  }
  return skills
}

export function getSkills(projectRoot?: string): Skill[] {
  const now = Date.now()
  if (cache && now < cache.expiresAt) return cache.skills

  const system = [
    ...scanDir(join(homedir(), '.claude', 'commands'), 'system'),
    ...scanUserSkillsDir(),
  ]
  const repo = projectRoot
    ? scanDir(join(projectRoot, '.claude', 'commands'), 'repo')
    : []
  const plugins = scanPlugins()

  const skills = [...system, ...repo, ...plugins]
  cache = { skills, expiresAt: now + TTL_MS }
  return skills
}

export function bustSkillCache(): void {
  cache = null
}
