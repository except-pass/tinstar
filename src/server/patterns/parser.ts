import { load as parseYaml } from 'js-yaml'

export interface PatternSessionConfig {
  backend?: 'tmux' | 'docker'
  project?: string
  worktree?: boolean
  worktreePath?: string
  skipPermissions?: boolean
  profile?: string
  cliTemplate?: string
  prompt?: string
  hand?: string

  // k8s-style orchestration (patterns-v2)
  dependsOn?: Record<string, { condition: 'ready' | 'started' }>
  replicas?: number
  readiness?: { nats: 'auto' | 'manual' }
}

export interface PatternSession {
  role: string  // 'orchestrator', 'worker', etc.
  config: PatternSessionConfig
}

export interface Pattern {
  name: string
  description: string
  orchestrator?: string
  sessions: PatternSession[]
}

/**
 * Parse a pattern file content (markdown with YAML frontmatter and body).
 * Returns null if parsing fails.
 */
export function parsePatternFile(content: string): Pattern | null {
  try {
    // Split frontmatter and body
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontmatterMatch) return null

    const frontmatter = parseYaml(frontmatterMatch[1]!) as Record<string, unknown>
    const body = frontmatterMatch[2]!.trim()

    const name = frontmatter.name as string
    const description = (frontmatter.description as string) ?? ''
    const orchestrator = frontmatter.orchestrator as string | undefined

    if (!name) return null

    // Parse body as YAML containing session definitions
    const bodyYaml = parseYaml(body) as Record<string, unknown>
    if (!bodyYaml || typeof bodyYaml !== 'object') return null

    const sessions: PatternSession[] = []

    for (const [role, config] of Object.entries(bodyYaml)) {
      if (config && typeof config === 'object') {
        sessions.push({
          role,
          config: config as PatternSessionConfig,
        })
      }
    }

    return { name, description, orchestrator, sessions }
  } catch {
    return null
  }
}
